require('dotenv').config();
const { App } = require('@slack/bolt');
const redis = require('redis');

// Initialize Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.connect().catch((err) => {
  console.error("Redis connection error:", err);
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.APP_TOKEN,
});

let workspaceDomain = null;

// Function to fetch and cache the Slack workspace domain
async function getWorkspaceDomain(client) {
  if (!workspaceDomain) {
    const response = await client.team.info();
    workspaceDomain = response.team.domain;
  }
  return workspaceDomain;
}

// Function to send DM to users
async function sendDM(client, userId, message) {
  try {
    await client.chat.postMessage({
      channel: userId,
      text: message,
    });
  } catch (error) {
    console.error(`Failed to send DM to ${userId}: ${error.message}`);
  }
}

// Function to extract user mentions from the topic
function extractUserIdsFromTopic(topic) {
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const userIds = [];
  let match;
  while ((match = mentionRegex.exec(topic)) !== null) {
    userIds.push(match[1]);
  }
  return userIds;
}

// Function to add a pending task to Redis
async function addPendingTask(threadId, taskData) {
  await redisClient.hSet("pendingTasks", threadId, JSON.stringify(taskData));
}

// Function to remove a task from Redis
async function removePendingTask(threadId) {
  await redisClient.hDel("pendingTasks", threadId);
}

// Function to retrieve all pending tasks from Redis
async function getPendingTasks() {
  const tasks = await redisClient.hGetAll("pendingTasks");
  return Object.entries(tasks).map(([threadId, taskData]) => ({
    threadId,
    ...JSON.parse(taskData),
  }));
}

(async () => {
  try {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ SlackDog just woke up ${port}`);
  } catch (error) {
    console.error("Failed to start Slack app:", error);
    process.exit(1);
  }
})();

// Listen for topic changes
app.event('message', async ({ event, client, logger }) => {
  try {
    if (event.subtype === 'channel_topic') {
      logger.info(`Topic changed: ${JSON.stringify(event)}`);

      const topic = event.topic || '';
      const userIds = extractUserIdsFromTopic(topic);
      const domain = await getWorkspaceDomain(client);

      const pendingTasks = await getPendingTasks();
      const pendingThreads = pendingTasks
        .map((data, index) => {
          const formattedTs = data.threadId.replace('.', ''); // Remove the dot in the timestamp
          const threadLink = `<https://${domain}.slack.com/archives/${data.channel}/p${formattedTs}|Thread>`;
          return `${index + 1}. ${data.text}... ${threadLink}`;
        })
        .join('\n');

      const pendingMessage = pendingThreads
        ? `Here are the pending tasks:\n${pendingThreads}`
        : `There are currently no pending tasks.`;

      const instructions = `
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Hello! Please review the pending tasks for today. To work on a task:
- Browse the relevant thread.
- Avoid long chit-chat.
- Continue the discussion under the thread (don't reply to the bot directly).
- Mark the task as completed by commenting "@completed" under the respective thread.

${pendingMessage}
      `;

      for (const userId of userIds) {
        await sendDM(client, userId, instructions);
      }
    }
  } catch (error) {
    logger.error(`Error processing topic change: ${error.message}`);
  }
});

// Handle @list_pending
app.message(async ({ message, say, logger, client }) => {
  try {
    logger.info(`Message received: ${JSON.stringify(message)}`);

    const domain = await getWorkspaceDomain(client);

    // Check for "@list_pending"
    if (message.text && message.text.includes("@list_pending")) {
      const pendingTasks = await getPendingTasks();
      const pendingThreads = pendingTasks
        .map((data, index) => {
          const formattedTs = data.threadId.replace('.', ''); // Remove the dot in the timestamp
          const threadLink = `<https://${domain}.slack.com/archives/${data.channel}/p${formattedTs}|Thread>`;
          return `${index + 1}. :sparkles: ${data.text}... ${threadLink}`;
        })
        .join('\n');

      if (pendingThreads) {
        await say(`Here are the pending threads:\n${pendingThreads}`);
      } else {
        await say("No pending threads at the moment.");
      }
    }

    // Check for "@pending"
    if (message.text && message.text.includes("@pending")) {
      const threadId = message.thread_ts || message.ts;
      const channelId = message.channel;

      if (!threadId) {
        await say("Please use @pending within a thread.");
        return;
      }

      const parentMessage = await client.conversations.replies({
        channel: channelId,
        ts: threadId,
        limit: 1,
      });

      const parentText = parentMessage.messages?.[0]?.text || "No parent message found.";
      const truncatedText = parentText.substring(0, 50); // Limit to 50 characters

      await addPendingTask(threadId, {
        status: 'pending',
        channel: channelId,
        text: truncatedText,
        comment: message.text,
      });

      await say({
        text: `Thread marked as pending!`,
        thread_ts: threadId,
      });
      logger.info(`Thread ${threadId} marked as pending.`);
    }

    // Check for "@completed"
    if (message.text && message.text.includes("@completed")) {
      const threadId = message.thread_ts || message.ts;

      if (!threadId) {
        await say("Please use @completed within a thread.");
        return;
      }

      await removePendingTask(threadId);

      await say({
        text: `Thread marked as completed!`,
        thread_ts: threadId,
      });
      logger.info(`Thread ${threadId} marked as completed.`);
    }
  } catch (error) {
    logger.error(`Error processing message: ${error.message}`);
  }
});
