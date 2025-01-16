require('dotenv').config();
const { App } = require('@slack/bolt');
const redis = require('redis');

// Initialize Redis client with logs and timeout handling
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

const connectRedis = async () => {
  try {
    console.log("🔄 Connecting to Redis...");
    await redisClient.connect();
    console.log("✅ Redis connected successfully.");
  } catch (error) {
    console.error("❌ Redis connection error:", error.message);
    process.exit(1); // Exit if Redis fails to connect
  }
};
connectRedis();

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
    console.log(`🌐 Workspace domain: ${workspaceDomain}`);
  }
  return workspaceDomain;
}

// Function to send a DM to a user
async function sendDM(client, userId, text) {
  try {
    // Open a conversation with the user
    const result = await client.conversations.open({ users: userId });
    const channelId = result.channel.id;
    // Post the message to the DM channel
    await client.chat.postMessage({
      channel: channelId,
      text: text
    });
  } catch (error) {
    console.error(`Error sending DM to ${userId}: ${error.message}`);
  }
}

// Function to add a pending task to Redis
async function addPendingTask(threadId, taskData) {
  console.log(`📝 Adding pending task: ${threadId}`);
  await redisClient.hSet("pendingTasks", threadId, JSON.stringify(taskData));
}

// Function to remove a task from Redis
async function removePendingTask(threadId) {
  console.log(`✅ Removing completed task: ${threadId}`);
  await redisClient.hDel("pendingTasks", threadId);
}

// Function to retrieve all pending tasks from Redis
async function getPendingTasks() {
  const tasks = await redisClient.hGetAll("pendingTasks");
  console.log(`📋 Fetched pending tasks: ${Object.keys(tasks).length} tasks`);
  return Object.entries(tasks).map(([threadId, taskData]) => ({
    threadId,
    ...JSON.parse(taskData),
  }));
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

// Function to send a reminder after a specified delay
async function setReminder(client, userId, threadId, delayInMs) {
  console.log(`⏰ Setting reminder for thread ${threadId} in ${delayInMs}ms`);
  setTimeout(async () => {
    try {
      if (!workspaceDomain) {
        await getWorkspaceDomain(client);
      }
      
      const task = await redisClient.hGet("pendingTasks", threadId);
      if (task) {
        const taskData = JSON.parse(task);
        const message = `
🔔 Reminder: The task in this thread is still pending!
- Task: ${taskData.text}
- <https://${workspaceDomain}.slack.com/archives/${taskData.channel}/p${threadId.replace('.', '')}|Go to thread>
        `;
        await client.chat.postMessage({
          channel: userId,
          text: message,
        });
        console.log(`🔔 Reminder sent for thread ${threadId}`);
      } else {
        console.log(`ℹ️ No pending task found for thread ${threadId}. Reminder skipped.`);
      }
    } catch (error) {
      console.error(`❌ Error sending reminder for thread ${threadId}: ${error.message}`);
    }
  }, delayInMs);
}

// Start the bot
(async () => {
  try {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Slack bot is running on port ${port}`);
  } catch (error) {
    console.error("❌ Slack app failed to start:", error.message);
    process.exit(1);
  }
})();

// Listen for message events with subtype channel_topic to handle topic changes
app.event('message', async ({ event, client, logger }) => {
  try {
    if (event.subtype === 'channel_topic') {
      logger.info(`Topic changed: ${JSON.stringify(event)}`);

      const topic = event.topic || '';
      const userIds = extractUserIdsFromTopic(topic);
      const domain = await getWorkspaceDomain(client);

      // Fetch pending tasks from Redis
      const pendingTasks = await getPendingTasks();

      // Skip sending messages if there are no pending tasks or no users mentioned
      if (pendingTasks.length === 0 || userIds.length === 0) {
        logger.info("No pending tasks or no users mentioned, skipping message.");
        return;
      }

      // Prepare pending tasks list
      const pendingThreads = pendingTasks
        .map((data, index) => {
          const formattedTs = data.threadId.replace('.', '');
          const threadLink = `<https://${domain}.slack.com/archives/${data.channel}/p${formattedTs}|Thread>`;
          return `${index + 1}. ${data.text}... ${threadLink}`;
        })
        .join('\n');

      const pendingMessage = `Here are the pending tasks:\n${pendingThreads}`;

      const instructions = `
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Hello! Please review the pending tasks for today. To work on a task:
- Browse the relevant thread.
- Avoid long chit-chat.
- Continue the discussion under the thread (don't reply to the bot directly).
- Mark the task as completed by commenting "@completed" under the respective thread.

${pendingMessage}
      `;

      // Send DM to all mentioned users
      for (const userId of userIds) {
        await sendDM(client, userId, instructions);
      }
    }
  } catch (error) {
    logger.error(`Error processing topic change: ${error.message}`);
  }
});

// Handle messages with various commands
app.message(async ({ message, say, client, logger }) => {
  try {
    logger.info(`📩 Message received: ${JSON.stringify(message)}`);

    await getWorkspaceDomain(client);

    // Handle "@pending" command
    if (message.text && message.text.includes("@pending")) {
      const threadId = message.thread_ts || message.ts;
      const channelId = message.channel;

      const parentMessage = await client.conversations.replies({
        channel: channelId,
        ts: threadId,
        limit: 1,
      });

      const parentText = parentMessage.messages?.[0]?.text || "No parent message found.";
      const truncatedText = parentText.substring(0, 50);

      await addPendingTask(threadId, {
        status: 'pending',
        channel: channelId,
        text: truncatedText,
        comment: message.text,
      });

      await say({
        text: `Thread marked as pending! If you like to set a reminder for this task, Reply with "remind me in X minutes".`,
        thread_ts: threadId,
      });

      logger.info(`📌 Thread ${threadId} marked as pending.`);
    }

    // Handle reminder command
    if (message.text && message.text.toLowerCase().startsWith("remind me in")) {
      const match = message.text.match(/remind me in (\d+)\s*(minute|hour|day)s?/i);
      if (match) {
        const amount = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();

        let delayInMs;
        if (unit.startsWith("minute")) delayInMs = amount * 60 * 1000;
        else if (unit.startsWith("hour")) delayInMs = amount * 60 * 60 * 1000;
        else if (unit.startsWith("day")) delayInMs = amount * 24 * 60 * 60 * 1000;

        const threadId = message.thread_ts || message.ts;
        if (!threadId) {
          await say("Please set reminder within a thread.");
          return;
        }

        if (delayInMs) {
          await say({
            text: `Got it! I'll remind you about this task in ${amount} ${unit}(s).`,
            thread_ts: message.thread_ts,
          });

          await setReminder(client, message.user, threadId, delayInMs);
        }
      }
    }

    // Handle "@completed" command
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
      logger.info(`✅ Thread ${threadId} marked as completed.`);
    }

    // Handle "@list_pending" command
    if (message.text && message.text.includes("@list_pending")) {
      const tasks = await getPendingTasks();
      if (!tasks.length) {
        await say({
          text: "No pending tasks found.",
          thread_ts: message.thread_ts || message.ts,
        });
      } else {
        let listMessage = "*Pending tasks:*\n";
        tasks.forEach(task => {
          listMessage += `• <https://${workspaceDomain}.slack.com/archives/${task.channel}/p${task.threadId.replace('.', '')}|Go to thread> - ${task.text}\n`;
        });
        await say({
          text: listMessage,
          thread_ts: message.thread_ts || message.ts,
        });
      }
    }
  } catch (error) {
    logger.error(`❌ Error processing message: ${error.message}`);
  }
});
