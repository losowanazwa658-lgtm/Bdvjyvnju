const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const path = require('path');

// Read environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_X_ID = process.env.GROUP_X_ID; // Link Sharin' Chat ID (e.g., -1004350125558)
const GROUP_Y_ID = process.env.GROUP_Y_ID; // Secret Paradise Chat ID (e.g., -1005055526739)
const REQUIRED_INVITES = parseInt(process.env.REQUIRED_INVITES || '5', 10);

if (!BOT_TOKEN || !GROUP_X_ID || !GROUP_Y_ID) {
  console.error('ERROR: Missing BOT_TOKEN, GROUP_X_ID, or GROUP_Y_ID in environment variables!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Initialize SQLite Database
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
const getInvitesStmt = db.prepare('SELECT invites_count, rewarded FROM users WHERE user_id = ?');

// 1. User starts the bot to get their unique Link Sharin' referral link
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = getUserStmt.get(userId);
  let inviteLink = user ? user.invite_link : null;

  // Generate a unique Link Sharin' invite link for this user if they don't have one
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
      return ctx.reply('⚠️ Error generating invite link. Make sure the bot is an Admin in Link Sharin\' with "Invite Users via Link" permission!');
    }
  }

  const invitesCount = user ? user.invites_count : 0;

  await ctx.reply(
    `Hello ${ctx.from.first_name}! 👋\n\n` +
    `Here is your unique invite link for **Link Sharin'**:\n` +
    `🔗 ${inviteLink}\n\n` +
    `📊 **Progress:** ${invitesCount}/${REQUIRED_INVITES} members invited to Link Sharin'\n\n` +
    `Share this link! Every time someone joins using your link, I will send you a progress update.\n` +
    `Once you reach **${REQUIRED_INVITES} invites**, I will send you your personal single-use link to **Secret Paradise**!`,
    { parse_mode: 'Markdown' }
  );
});

// 2. Command to check current status
bot.command(['status', 'progress'], async (ctx) => {
  const userId = ctx.from.id;
  const user = getUserStmt.get(userId);
  const invitesCount = user ? user.invites_count : 0;
  const inviteLink = user ? user.invite_link : 'Type /start to generate your link';

  await ctx.reply(
    `📊 **Your Invite Progress:**\n` +
    `Invited to Link Sharin': **${invitesCount}/${REQUIRED_INVITES}** members\n\n` +
    `🔗 **Your Link Sharin' Referral Link:**\n${inviteLink}`,
    { parse_mode: 'Markdown' }
  );
});

// 3. Track when a new member joins Link Sharin' via a tracked invite link
bot.on('chat_member', async (ctx) => {
  const chatMember = ctx.chatMember;
  const chatId = ctx.chat.id.toString();

  // Check if event is from Link Sharin' and status indicates a new member joined
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

        console.log(`User joined Link Sharin' via link owned by ${referrerId}. Total invites: ${currentInvites}`);

        // Send progress updates on every single invite
        try {
          if (currentInvites < REQUIRED_INVITES) {
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 **New Invite Detected!**\n\n` +
              `Someone just joined Link Sharin' using your link!\n` +
              `📊 **Current Progress:** ${currentInvites}/${REQUIRED_INVITES}\n\n` +
              `Invite **${REQUIRED_INVITES - currentInvites} more** to get your link to Secret Paradise!`
            );
          } else {
            // Reached 5 invites!
            if (!alreadyRewarded) {
              setRewardedStmt.run(referrerId);

              // Generate a 1-time single-use invite link for Secret Paradise (member_limit = 1)
              const groupYInvite = await ctx.telegram.createChatInviteLink(GROUP_Y_ID, {
                member_limit: 1,
                expire_date: Math.floor(Date.now() / 1000) + 86400 // Valid for 24h
              });

              await ctx.telegram.sendMessage(
                referrerId,
                `🏆 **GOAL REACHED! (${currentInvites}/${REQUIRED_INVITES})**\n\n` +
                `Congratulations! You have invited ${REQUIRED_INVITES} people to Link Sharin'.\n\n` +
                `Here is your **single-use** invite link to **Secret Paradise**:\n` +
                `🔗 ${groupYInvite.invite_link}\n\n` +
                `*(Note: This link can only be used ONCE. After you click and join, it self-destructs!)*`,
                { parse_mode: 'Markdown' }
              );
            } else {
              // User already got rewarded earlier, notify of extra invites
              await ctx.telegram.sendMessage(
                referrerId,
                `🎉 Someone else joined using your link!\n` +
                `📊 **Total Invites:** ${currentInvites}`
              );
            }
          }
        } catch (err) {
          console.error('Failed to notify referrer:', err.message);
        }
      }
    }
  }
});

bot.launch().then(() => {
  console.log('Group Referral Bot is running!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
