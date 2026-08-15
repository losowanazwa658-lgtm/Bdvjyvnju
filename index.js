const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const path = require('path');

// Wczytanie zmiennych środowiskowych
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_X_ID = process.env.GROUP_X_ID; // ID Grupy X (np. -1004350125558)
const GROUP_Y_ID = process.env.GROUP_Y_ID; // ID Grupy Y (np. -1005055526739)
const REQUIRED_INVITES = parseInt(process.env.REQUIRED_INVITES || '5', 10);
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

// 1. Komenda /start - generowanie unikalnego linku polecającego dla Grupy X
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
      console.error("Error creating chat invite link for Group X:", err);
      return ctx.reply('⚠️ Error generating invite link. Make sure the bot is an Admin in Group X with "Invite Users via Link" permission!');
    }
  }

  const invitesCount = user ? user.invites_count : 0;
  const firstName = escapeHtml(ctx.from.first_name);

  await ctx.reply(
    `Hello <b>${firstName}</b>! 👋\n\n` +
    `Here is your unique invite link for <b>Group X</b>:\n` +
    `🔗 <code>${inviteLink}</code>\n\n` +
    `📊 <b>Progress:</b> ${invitesCount}/${REQUIRED_INVITES} members invited\n\n` +
    `Share this link! Every time someone joins using your link, I will send you a progress update.\n` +
    `Once you reach <b>${REQUIRED_INVITES} invite${REQUIRED_INVITES === 1 ? '' : 's'}</b>, I will send you your personal single-use link to <b>Secret Group Y</b>!`,
    { parse_mode: 'HTML' }
  );
});

// 2. Komenda /status oraz /progress
bot.command(['status', 'progress'], async (ctx) => {
  const userId = ctx.from.id;
  const user = getUserStmt.get(userId);
  const invitesCount = user ? user.invites_count : 0;
  const inviteLink = user ? user.invite_link : 'Type /start to generate your link';

  await ctx.reply(
    `📊 <b>Your Invite Progress:</b>\n` +
    `Invited to Group X: <b>${invitesCount}/${REQUIRED_INVITES}</b> members\n\n` +
    `🔗 <b>Your Group X Referral Link:</b>\n<code>${inviteLink}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 3. Reakcja na dołączenie nowego członka do Grupy X za pomocą linku
bot.on('chat_member', async (ctx) => {
  const chatMember = ctx.chatMember;
  const chatId = ctx.chat.id.toString();

  // Sprawdzamy czy zdarzenie pochodzi z Grupy X i czy nowy status to "member"
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

        console.log(`New user joined Group X via link owned by ${referrerId}. Total invites: ${currentInvites}`);

        try {
          if (currentInvites < REQUIRED_INVITES) {
            const remaining = REQUIRED_INVITES - currentInvites;
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 <b>New Invite Detected!</b>\n\n` +
              `Someone just joined Group X using your link!\n` +
              `📊 <b>Current Progress:</b> ${currentInvites}/${REQUIRED_INVITES}\n\n` +
              `Invite <b>${remaining} more ${remaining === 1 ? 'person' : 'people'}</b> to get your link to Secret Group Y!`,
              { parse_mode: 'HTML' }
            );
          } else {
            // Osiągnięto wymaganą liczbę zaproszeń!
            if (!alreadyRewarded) {
              setRewardedStmt.run(referrerId);

              // Generowanie jednorazowego linku do Grupy Y (member_limit = 1)
              const groupYInvite = await ctx.telegram.createChatInviteLink(GROUP_Y_ID, {
                member_limit: 1,
                expire_date: Math.floor(Date.now() / 1000) + 86400 // Ważne przez 24 godz.
              });

              // Send private notification & link to the referrer
              await ctx.telegram.sendMessage(
                referrerId,
                `🏆 <b>GOAL REACHED! (${currentInvites}/${REQUIRED_INVITES})</b>\n\n` +
                `Congratulations! You have successfully invited ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'person' : 'people'} to Group X.\n\n` +
                `Here is your <b>single-use</b> access link to <b>Secret Group Y</b>:\n` +
                `🔗 <code>${groupYInvite.invite_link}</code>\n\n` +
                `<i>(Note: This link can only be used ONCE. After you click and join, it self-destructs!)</i>`,
                { parse_mode: 'HTML' }
              );

              // Pobranie danych zapraszającego użytkownika do oznaczenia w ogłoszeniu publicznym
              let referrerDisplayName = `User ${referrerId}`;
              try {
                const memberInfo = await ctx.telegram.getChatMember(GROUP_X_ID, referrerId);
                if (memberInfo && memberInfo.user) {
                  referrerDisplayName = memberInfo.user.username 
                    ? `@${memberInfo.user.username}` 
                    : escapeHtml(memberInfo.user.first_name);
                }
              } catch (e) {
                console.error("Could not fetch referrer details for announcement:", e.message);
              }

              const botUsername = ctx.botInfo.username;

              // Wysyłka wiadomości publicznej na wybrany wątek (Topic ID: 400)
              await ctx.telegram.sendMessage(
                GROUP_X_ID,
                `🎉 <b>${referrerDisplayName}</b> invited ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'person' : 'people'} and unlocked the secret channel!\n\n` +
                `👉 Want to unlock it too? Get your invite link here: https://t.me/${botUsername}`,
                { 
                  parse_mode: 'HTML',
                  message_thread_id: ANNOUNCEMENT_THREAD_ID 
                }
              );

            } else {
              // Użytkownik już dostał nagrodę wcześniej
              await ctx.telegram.sendMessage(
                referrerId,
                `🎉 Someone else joined using your link!\n` +
                `📊 <b>Total Invites:</b> ${currentInvites}`
              );
            }
          }
        } catch (err) {
          console.error('Failed to notify referrer or send announcement:', err.message);
        }
      }
    }
  }
});

// Włączenie odbierania zdarzeń `chat_member`
bot.launch({
  allowedUpdates: ['message', 'chat_member']
}).then(() => {
  console.log('Group Referral Bot is running!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
