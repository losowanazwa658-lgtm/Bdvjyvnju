const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const path = require('path');

// Wczytanie zmiennych środowiskowych
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_X_ID = process.env.GROUP_X_ID; // ID grupy "Link Sharin'" (np. -1004350125558)
const GROUP_Y_ID = process.env.GROUP_Y_ID; // ID grupy "Secret Paradise" (np. -1005055526739)
const REQUIRED_INVITES = parseInt(process.env.REQUIRED_INVITES || '1', 10);
// ID wątku/topicu z linku https://t.me/c/4350125558/400
const ANNOUNCEMENT_THREAD_ID = parseInt(process.env.ANNOUNCEMENT_THREAD_ID || '400', 10);

if (!BOT_TOKEN || !GROUP_X_ID || !GROUP_Y_ID) {
  console.error('ERROR: Missing BOT_TOKEN, GROUP_X_ID, or GROUP_Y_ID in environment variables!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Inicjalizacja bazy danych SQLite
const db = new Database(path.join(__dirname, 'referrals.db'));

// Tworzenie tabel bazy danych
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    invite_link TEXT,
    invites_count INTEGER DEFAULT 0,
    rewarded INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS link_owners (
    invite_link TEXT PRIMARY KEY,
    owner_id INTEGER
  );
`);

// Przygotowane zapytania SQL
const getUserStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
const saveUserLinkStmt = db.prepare('INSERT INTO users (user_id, invite_link, invites_count, rewarded) VALUES (?, ?, 0, 0) ON CONFLICT(user_id) DO UPDATE SET invite_link = excluded.invite_link');
const linkOwnerStmt = db.prepare('INSERT OR REPLACE INTO link_owners (invite_link, owner_id) VALUES (?, ?)');
const getOwnerByLinkStmt = db.prepare('SELECT owner_id FROM link_owners WHERE invite_link = ?');
const incrementInviteStmt = db.prepare('UPDATE users SET invites_count = invites_count + 1 WHERE user_id = ?');
const setRewardedStmt = db.prepare('UPDATE users SET rewarded = 1 WHERE user_id = ?');
const getInvitesStmt = db.prepare('SELECT invites_count, rewarded FROM users WHERE user_id = ?');

// Helper do bezpiecznego uciekania przed znakami HTML
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 1. Komenda /start - generowanie unikalnego linku polecającego dla grupy Link Sharin'
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = getUserStmt.get(userId);
  let inviteLink = user ? user.invite_link : null;

  if (!inviteLink) {
    try {
      const linkObject = await ctx.telegram.createChatInviteLink(GROUP_X_ID, {
        name: `User_${userId}_Ref`
      });
      inviteLink = linkObject.invite_link;

      saveUserLinkStmt.run(userId, inviteLink);
      linkOwnerStmt.run(inviteLink, userId);
    } catch (err) {
      console.error("Error creating chat invite link for Link Sharin':", err);
      return ctx.reply('⚠️ Błąd podczas generowania linku zapraszającego. Upewnij się, że bot jest administratorem w grupie Link Sharin\' z uprawnieniem do tworzenia linków!');
    }
  }

  const invitesCount = user ? user.invites_count : 0;
  const firstName = escapeHtml(ctx.from.first_name);

  await ctx.reply(
    `Cześć <b>${firstName}</b>! 👋\n\n` +
    `Oto Twój unikalny link polecający do grupy <b>Link Sharin'</b>:\n` +
    `🔗 <code>${inviteLink}</code>\n\n` +
    `📊 <b>Postęp:</b> Zaproszono ${invitesCount}/${REQUIRED_INVITES} osób\n\n` +
    `Udostępnij ten link! Za każdym razem, gdy ktoś dołączy do grupy <b>Link Sharin'</b> z Twojego linku, wyślę Ci powiadomienie.\n` +
    `Gdy zaprosisz <b>${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'osobę' : 'osób/y'}</b>, wyślę Ci Twój osobisty, jednorazowy link do <b>Secret Paradise</b>!`,
    { parse_mode: 'HTML' }
  );
});

// 2. Komenda /status oraz /progress
bot.command(['status', 'progress'], async (ctx) => {
  const userId = ctx.from.id;
  const user = getUserStmt.get(userId);
  const invitesCount = user ? user.invites_count : 0;
  const inviteLink = user ? user.invite_link : 'Wpisz /start aby wygenerować Twój link';

  await ctx.reply(
    `📊 <b>Twój postęp zaproszeń:</b>\n` +
    `Zaproszono do Link Sharin': <b>${invitesCount}/${REQUIRED_INVITES}</b> członków\n\n` +
    `🔗 <b>Twój link polecający do Link Sharin':</b>\n<code>${inviteLink}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 3. Reakcja na dołączenie nowego członka do grupy Link Sharin' za pomocą linku
bot.on('chat_member', async (ctx) => {
  const chatMember = ctx.chatMember;
  const chatId = ctx.chat.id.toString();

  // Sprawdzamy czy zdarzenie pochodzi z grupy Link Sharin' i czy nowy status to "member"
  if (chatId === GROUP_X_ID.toString() && chatMember.new_chat_member.status === 'member') {
    const usedLink = chatMember.invite_link ? chatMember.invite_link.invite_link : null;

    if (usedLink) {
      const owner = getOwnerByLinkStmt.get(usedLink);

      if (owner) {
        const referrerId = owner.owner_id;
        incrementInviteStmt.run(referrerId);

        const userRecord = getInvitesStmt.get(referrerId);
        const currentInvites = userRecord ? userRecord.invites_count : 0;
        const alreadyRewarded = userRecord ? userRecord.rewarded : 0;

        console.log(`Nowy użytkownik dołączył do Link Sharin' z linku użytkownika ${referrerId}. Razem zaproszeń: ${currentInvites}`);

        try {
          if (currentInvites < REQUIRED_INVITES) {
            const remaining = REQUIRED_INVITES - currentInvites;
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 <b>Wykryto nowe zaproszenie!</b>\n\n` +
              `Ktoś właśnie dołączył do grupy Link Sharin' z Twojego linku!\n` +
              `📊 <b>Aktualny postęp:</b> ${currentInvites}/${REQUIRED_INVITES}\n\n` +
              `Zaproś jeszcze <b>${remaining} ${remaining === 1 ? 'osobę' : 'osób/y'}</b>, aby otrzymać darmowy dostęp do Secret Paradise!`,
              { parse_mode: 'HTML' }
            );
          } else {
            // Osiągnięto wymaganą liczbę zaproszeń!
            if (!alreadyRewarded) {
              setRewardedStmt.run(referrerId);

              // Generowanie jednorazowego linku do grupy Secret Paradise (member_limit = 1)
              const groupYInvite = await ctx.telegram.createChatInviteLink(GROUP_Y_ID, {
                member_limit: 1,
                expire_date: Math.floor(Date.now() / 1000) + 86400 // Ważny przez 24 godziny
              });

              // Wiadomość prywatna do użytkownika, który wygrał dostęp
              await ctx.telegram.sendMessage(
                referrerId,
                `🏆 <b>CEL OSIĄGNIĘTY! (${currentInvites}/${REQUIRED_INVITES})</b>\n\n` +
                `Gratulacje! Udało Ci się zaprosić wymagane ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'osobę' : 'osób/y'} do grupy Link Sharin'.\n\n` +
                `Oto Twój <b>jednorazowy</b> link dostępowy do grupy <b>Secret Paradise</b>:\n` +
                `🔗 <code>${groupYInvite.invite_link}</code>\n\n` +
                `<i>(Uwaga: Ten link może być użyty tylko RAZ. Po wejściu link wygaśnie!)</i>`,
                { parse_mode: 'HTML' }
              );

              // Pobranie danych zapraszającego użytkownika (imienia/nazwy)
              let referrerDisplayName = `user ${referrerId}`;
              try {
                const memberInfo = await ctx.telegram.getChatMember(GROUP_X_ID, referrerId);
                if (memberInfo && memberInfo.user) {
                  referrerDisplayName = memberInfo.user.username 
                    ? `@${memberInfo.user.username}` 
                    : escapeHtml(memberInfo.user.first_name);
                }
              } catch (e) {
                console.error("Nie udało się pobrać szczegółów użytkownika do ogłoszenia:", e.message);
              }

              const botUsername = ctx.botInfo.username;

              // Wysyłka wiadomości publicznej na wybrany wątek w grupie Link Sharin' (Topic ID: 400)
              await ctx.telegram.sendMessage(
                GROUP_X_ID,
                `🎉 user <b>${referrerDisplayName}</b> invited ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'people' : 'people'} and unlocked the secret channel\n\n` +
                `👉 https://t.me/${botUsername}`,
                { 
                  parse_mode: 'HTML',
                  message_thread_id: ANNOUNCEMENT_THREAD_ID 
                }
              );

            } else {
              // Użytkownik już dostał nagrodę wcześniej
              await ctx.telegram.sendMessage(
                referrerId,
                `🎉 Kolejna osoba dołączyła z Twojego linku!\n` +
                `📊 <b>Łącznie zaproszono:</b> ${currentInvites}`
              );
            }
          }
        } catch (err) {
          console.error('Błąd podczas powiadamiania użytkownika lub wysyłania ogłoszenia:', err.message);
        }
      }
    }
  }
});

// Włączenie odbierania zdarzeń `chat_member`
bot.launch({
  allowedUpdates: ['message', 'chat_member']
}).then(() => {
  console.log('Bot poleceń dla Link Sharin\' oraz Secret Paradise działa!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
