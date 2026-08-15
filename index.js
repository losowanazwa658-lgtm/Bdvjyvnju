const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const path = require('path');

// Load environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_X_ID = process.env.GROUP_X_ID; // "Link Sharin'" Group ID
const GROUP_Y_ID = process.env.GROUP_Y_ID; // "Secret Paradise" Group ID
const REQUIRED_INVITES = parseInt(process.env.REQUIRED_INVITES || '1', 10);
const ANNOUNCEMENT_THREAD_ID = parseInt(process.env.ANNOUNCEMENT_THREAD_ID || '400', 10);

if (!BOT_TOKEN || !GROUP_X_ID || !GROUP_Y_ID) {
  console.error('ERROR: Missing BOT_TOKEN, GROUP_X_ID, or GROUP_Y_ID in environment variables!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'referrals.db'));

// Create database tables
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

// Prepared SQL statements
const getUserStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
const saveUserLinkStmt = db.prepare('INSERT INTO users (user_id, invite_link, invites_count, rewarded) VALUES (?, ?, 0, 0) ON CONFLICT(user_id) DO UPDATE SET invite_link = excluded.invite_link');
const linkOwnerStmt = db.prepare('INSERT OR REPLACE INTO link_owners (invite_link, owner_id) VALUES (?, ?)');
const getOwnerByLinkStmt = db.prepare('SELECT owner_id FROM link_owners WHERE invite_link = ?');
const incrementInviteStmt = db.prepare('UPDATE users SET invites_count = invites_count + 1 WHERE user_id = ?');
const setRewardedStmt = db.prepare('UPDATE users SET rewarded = 1 WHERE user_id = ?');
const resetUserStmt = db.prepare('UPDATE users SET invites_count = 0, rewarded = 0 WHERE user_id = ?');

// Helper to safely escape HTML special characters
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 1. /start command
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
      user = getUserStmt.get(userId);
    } catch (err) {
      console.error("Error creating chat invite link for Link Sharin':", err);
      return ctx.reply('⚠️ Error generating invite link. Make sure the bot is an Admin in "Link Sharin\'" with "Invite Users via Link" permission!');
    }
  }

  const invitesCount = user ? user.invites_count : 0;
  const firstName = escapeHtml(ctx.from.first_name);

  await ctx.reply(
    `Hello <b>${firstName}</b>! 👋\n\n` +
    `Here is your unique invite link for <b>Link Sharin'</b>:\n` +
    `🔗 <code>${inviteLink}</code>\n\n` +
    `📊 <b>Progress:</b> ${invitesCount}/${REQUIRED_INVITES} members invited\n\n` +
    `Share this link! Every time someone joins <b>Link Sharin'</b> using your link, I will send you a progress update.\n` +
    `Once you reach <b>${REQUIRED_INVITES} invite${REQUIRED_INVITES === 1 ? '' : 's'}</b>, I will send you your personal single-use link to <b>Secret Paradise</b>!`,
    { parse_mode: 'HTML' }
  );
});

// 2. /status & /progress
bot.command(['status', 'progress'], async (ctx) => {
  const userId = ctx.from.id;
  const user = getUserStmt.get(userId);
  const invitesCount = user ? user.invites_count : 0;
  const inviteLink = user ? user.invite_link : 'Type /start to generate your link';

  await ctx.reply(
    `📊 <b>Your Invite Progress:</b>\n` +
    `Invited to Link Sharin': <b>${invitesCount}/${REQUIRED_INVITES}</b> members\n\n` +
    `🔗 <b>Your Link Sharin' Referral Link:</b>\n<code>${inviteLink}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 3. /resetme command (Do testowania)
bot.command('resetme', async (ctx) => {
  const userId = ctx.from.id;
  resetUserStmt.run(userId);
  await ctx.reply('🔄 Your invite progress and reward status have been reset! Type /start to see your clean progress.');
});

// 4. Reaction to new member joining "Link Sharin'" via link
bot.on('chat_member', async (ctx) => {
  const chatMember = ctx.chatMember;
  const chatId = ctx.chat.id.toString();

  if (chatId === GROUP_X_ID.toString() && chatMember.new_chat_member.status === 'member') {
    const usedLink = chatMember.invite_link ? chatMember.invite_link.invite_link : null;

    if (usedLink) {
      const owner = getOwnerByLinkStmt.get(usedLink);

      if (owner) {
        const referrerId = owner.owner_id;
        incrementInviteStmt.run(referrerId);

        const userRecord = getUserStmt.get(referrerId);
        const currentInvites = userRecord ? userRecord.invites_count : 0;
        const alreadyRewarded = userRecord ? userRecord.rewarded : 0;

        console.log(`New user joined Link Sharin' via link owned by ${referrerId}. Total invites: ${currentInvites}`);

        try {
          // If the user hasn't met the quota yet
          if (currentInvites < REQUIRED_INVITES) {
            const remaining = REQUIRED_INVITES - currentInvites;
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 <b>New Invite Detected!</b>\n\n` +
              `Someone just joined Link Sharin' using your link!\n` +
              `📊 <b>Current Progress:</b> ${currentInvites}/${REQUIRED_INVITES}\n\n` +
              `Invite <b>${remaining} more ${remaining === 1 ? 'person' : 'people'}</b> to get your link to Secret Paradise!`,
              { parse_mode: 'HTML' }
            );
          } 
          // Reached or exceeded required invites
          else if (!alreadyRewarded) {
            setRewardedStmt.run(referrerId);

            // Generate single-use invite link for Secret Paradise
            const groupYInvite = await ctx.telegram.createChatInviteLink(GROUP_Y_ID, {
              member_limit: 1,
              expire_date: Math.floor(Date.now() / 1000) + 86400
            });

            // Send private message to referrer
            await ctx.telegram.sendMessage(
              referrerId,
              `🏆 <b>GOAL REACHED! (${currentInvites}/${REQUIRED_INVITES})</b>\n\n` +
              `Congratulations! You have successfully invited ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'person' : 'people'} to Link Sharin'.\n\n` +
              `Here is your <b>single-use</b> access link to <b>Secret Paradise</b>:\n` +
              `🔗 <code>${groupYInvite.invite_link}</code>\n\n` +
              `<i>(Note: This link can only be used ONCE. After you click and join, it self-destructs!)</i>`,
              { parse_mode: 'HTML' }
            );

            // Fetch user info for topic announcement
            let referrerDisplayName = `user ${referrerId}`;
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

            // Post public announcement in topic 400
            await ctx.telegram.sendMessage(
              GROUP_X_ID,
              `user <b>${referrerDisplayName}</b> invited ${REQUIRED_INVITES} ${REQUIRED_INVITES === 1 ? 'person' : 'people'} and unlocked the secret channel\n\n` +
              `👉 https://t.me/${botUsername}`,
              { 
                parse_mode: 'HTML',
                message_thread_id: ANNOUNCEMENT_THREAD_ID 
              }
            );
          } 
          // User already got rewarded previously
          else {
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 Someone else joined using your link!\n` +
              `📊 <b>Total Invites:</b> ${currentInvites}`,
              { parse_mode: 'HTML' }
            );
          }
        } catch (err) {
          console.error('Failed to process invite event:', err.message);
        }
      }
    }
  }
});

bot.launch({
  allowedUpdates: ['message', 'chat_member']
}).then(() => {
  console.log("Referral bot for Link Sharin' and Secret Paradise is running!");
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
