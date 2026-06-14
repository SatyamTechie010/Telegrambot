require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 10040;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Telegram Gemini Bot is running on Render 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is healthy",
  });
});

if (!process.env.TOKEN) {
  throw new Error("TOKEN is missing in .env file");
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in .env file");
}

const bot = new Telegraf(process.env.TOKEN);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TIMEZONE_OFFSET = process.env.TIMEZONE_OFFSET || "+05:30";

// Temporary in-memory database
// For production, use MongoDB/PostgreSQL because this data resets when server restarts.
const users = new Map();

function getUser(chatId) {
  if (!users.has(chatId)) {
    users.set(chatId, {
      todos: [],
      appointments: [],
      calls: [],
      reminders: [],
    });
  }

  return users.get(chatId);
}

function getArgs(ctx) {
  return ctx.message.text
    .replace(/^\/[a-zA-Z0-9_]+(@[a-zA-Z0-9_]+)?\s*/, "")
    .trim();
}

function parseDateTime(input) {
  // Format: YYYY-MM-DD HH:mm Message
  const match = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);

  if (!match) return null;

  const datePart = match[1];
  const timePart = match[2];
  const message = match[3];

  const date = new Date(`${datePart}T${timePart}:00${TIMEZONE_OFFSET}`);

  if (isNaN(date.getTime())) return null;

  return {
    date,
    message,
  };
}

function parseRelativeReminder(input) {
  // Format: 10m Message, 2h Message, 1d Message
  const match = input.match(/^(\d+)(s|m|h|d)\s+(.+)$/i);

  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const message = match[3];

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const date = new Date(Date.now() + value * multipliers[unit]);

  return {
    date,
    message,
  };
}

function formatDate(date) {
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function scheduleBotMessage(chatId, date, message) {
  const delay = date.getTime() - Date.now();

  if (delay <= 0) {
    return false;
  }

  // setTimeout max safe delay is around 24.8 days
  if (delay > 2147483647) {
    return false;
  }

  setTimeout(async () => {
    try {
      await bot.telegram.sendMessage(chatId, message);
    } catch (error) {
      console.log("Reminder send error:", error.message);
    }
  }, delay);

  return true;
}

async function askGemini(prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });

  return response.text || "No response generated.";
}

// Start command
bot.start(async (ctx) => {
  await ctx.reply(
    `Welcome To Professional Telegram Assistant Bot 🚀

Available Commands:

/help - Show all commands
/location - Send location
/appointment YYYY-MM-DD HH:mm Purpose
/appointments - View appointments
/call YYYY-MM-DD HH:mm Topic
/calls - View scheduled calls
/remind 10m Message
/remind YYYY-MM-DD HH:mm Message
/reminders - View reminders
/todo add Task
/todo list
/todo done 1
/todo delete 1

You can also send any normal message and I will reply using Gemini AI.`,
    Markup.keyboard([
      ["📅 Book Appointment", "📞 Schedule Call"],
      ["⏰ Reminder", "✅ Todo List"],
      ["📍 Location", "🤖 Ask AI"],
    ]).resize()
  );
});

// Help command
bot.help(async (ctx) => {
  await ctx.reply(
    `Bot Command Guide:

1. Book Appointment:
   /appointment 2026-06-20 17:30 Doctor visit

2. View Appointments:
   /appointments

3. Schedule Call:
   /call 2026-06-20 18:00 React project discussion

4. View Calls:
   /calls

5. Set Reminder:
   /remind 10m Submit assignment
   /remind 2h Drink water
   /remind 2026-06-20 19:00 Pay college fee

6. View Reminders:
   /reminders

7. Todo List:
   /todo add Learn Telegraf
   /todo list
   /todo done 1
   /todo delete 1

8. Location:
   /location

9. AI Chat:
   Just type any message normally.`
  );
});

// Location command
bot.command("location", async (ctx) => {
  await ctx.replyWithLocation(15.5553, 73.7517);
});

// Appointment command
bot.command("appointment", async (ctx) => {
  const chatId = ctx.chat.id;
  const user = getUser(chatId);
  const args = getArgs(ctx);

  const parsed = parseDateTime(args);

  if (!parsed) {
    return ctx.reply(
      `Wrong format.

Use:
 /appointment YYYY-MM-DD HH:mm Purpose

Example:
 /appointment 2026-06-20 17:30 Doctor appointment`
    );
  }

  if (parsed.date <= new Date()) {
    return ctx.reply("Appointment time must be in the future.");
  }

  user.appointments.push({
    date: parsed.date,
    purpose: parsed.message,
  });

  // Auto reminder 15 minutes before appointment
  const reminderTime = new Date(parsed.date.getTime() - 15 * 60 * 1000);

  if (reminderTime > new Date()) {
    scheduleBotMessage(
      chatId,
      reminderTime,
      `Appointment Reminder: ${parsed.message}\nTime: ${formatDate(parsed.date)}`
    );
  }

  await ctx.reply(
    `Appointment booked successfully.

Purpose: ${parsed.message}
Time: ${formatDate(parsed.date)}

I will remind you 15 minutes before the appointment.`
  );
});

// View appointments
bot.command("appointments", async (ctx) => {
  const user = getUser(ctx.chat.id);

  if (user.appointments.length === 0) {
    return ctx.reply("No appointments found.");
  }

  const list = user.appointments
    .map((item, index) => {
      return `${index + 1}. ${item.purpose} - ${formatDate(item.date)}`;
    })
    .join("\n");

  await ctx.reply(`Your Appointments:\n\n${list}`);
});

// Schedule call command
async function handleCall(ctx) {
  const chatId = ctx.chat.id;
  const user = getUser(chatId);
  const args = getArgs(ctx);

  const parsed = parseDateTime(args);

  if (!parsed) {
    return ctx.reply(
      `Wrong format.

Use:
 /call YYYY-MM-DD HH:mm Topic

Example:
 /call 2026-06-20 18:00 Project discussion`
    );
  }

  if (parsed.date <= new Date()) {
    return ctx.reply("Call time must be in the future.");
  }

  user.calls.push({
    date: parsed.date,
    topic: parsed.message,
  });

  const reminderTime = new Date(parsed.date.getTime() - 10 * 60 * 1000);

  if (reminderTime > new Date()) {
    scheduleBotMessage(
      chatId,
      reminderTime,
      `Scheduled Call Reminder: ${parsed.message}\nTime: ${formatDate(parsed.date)}`
    );
  }

  await ctx.reply(
    `Call scheduled successfully.

Topic: ${parsed.message}
Time: ${formatDate(parsed.date)}

I will remind you 10 minutes before the call.`
  );
}

bot.command("call", handleCall);
bot.command("schedulecall", handleCall);

// View calls
bot.command("calls", async (ctx) => {
  const user = getUser(ctx.chat.id);

  if (user.calls.length === 0) {
    return ctx.reply("No scheduled calls found.");
  }

  const list = user.calls
    .map((item, index) => {
      return `${index + 1}. ${item.topic} - ${formatDate(item.date)}`;
    })
    .join("\n");

  await ctx.reply(`Your Scheduled Calls:\n\n${list}`);
});

// Reminder command
bot.command("remind", async (ctx) => {
  const chatId = ctx.chat.id;
  const user = getUser(chatId);
  const args = getArgs(ctx);

  let parsed = parseRelativeReminder(args);

  if (!parsed) {
    parsed = parseDateTime(args);
  }

  if (!parsed) {
    return ctx.reply(
      `Wrong format.

Use:
 /remind 10m Submit assignment
 /remind 2h Drink water
 /remind 2026-06-20 19:00 Pay fee

Supported short time:
s = seconds
m = minutes
h = hours
d = days`
    );
  }

  if (parsed.date <= new Date()) {
    return ctx.reply("Reminder time must be in the future.");
  }

  user.reminders.push({
    date: parsed.date,
    message: parsed.message,
  });

  const scheduled = scheduleBotMessage(
    chatId,
    parsed.date,
    `Reminder: ${parsed.message}`
  );

  if (!scheduled) {
    return ctx.reply(
      `Reminder saved, but automatic notification may not work for very long future dates in this simple version.`
    );
  }

  await ctx.reply(
    `Reminder set successfully.

Message: ${parsed.message}
Time: ${formatDate(parsed.date)}`
  );
});

// View reminders
bot.command("reminders", async (ctx) => {
  const user = getUser(ctx.chat.id);

  if (user.reminders.length === 0) {
    return ctx.reply("No reminders found.");
  }

  const list = user.reminders
    .map((item, index) => {
      return `${index + 1}. ${item.message} - ${formatDate(item.date)}`;
    })
    .join("\n");

  await ctx.reply(`Your Reminders:\n\n${list}`);
});

// Todo command
bot.command("todo", async (ctx) => {
  const user = getUser(ctx.chat.id);
  const args = getArgs(ctx);

  const [action, ...rest] = args.split(" ");
  const taskText = rest.join(" ").trim();

  if (!action) {
    return ctx.reply(
      `Todo Commands:

/todo add Learn Node.js
/todo list
/todo done 1
/todo delete 1`
    );
  }

  if (action === "add") {
    if (!taskText) {
      return ctx.reply("Please write a task. Example: /todo add Learn Express");
    }

    user.todos.push({
      task: taskText,
      done: false,
    });

    return ctx.reply(`Todo added: ${taskText}`);
  }

  if (action === "list") {
    if (user.todos.length === 0) {
      return ctx.reply("Your todo list is empty.");
    }

    const list = user.todos
      .map((todo, index) => {
        const status = todo.done ? "Done" : "Pending";
        return `${index + 1}. [${status}] ${todo.task}`;
      })
      .join("\n");

    return ctx.reply(`Your Todo List:\n\n${list}`);
  }

  if (action === "done") {
    const index = Number(rest[0]) - 1;

    if (isNaN(index) || !user.todos[index]) {
      return ctx.reply("Invalid todo number.");
    }

    user.todos[index].done = true;

    return ctx.reply(`Marked as done: ${user.todos[index].task}`);
  }

  if (action === "delete") {
    const index = Number(rest[0]) - 1;

    if (isNaN(index) || !user.todos[index]) {
      return ctx.reply("Invalid todo number.");
    }

    const deleted = user.todos.splice(index, 1);

    return ctx.reply(`Deleted todo: ${deleted[0].task}`);
  }

  return ctx.reply("Invalid todo command. Use /todo to see help.");
});

// Button text handlers
bot.hears("📅 Book Appointment", async (ctx) => {
  await ctx.reply(
    `Use this format:

/appointment 2026-06-20 17:30 Doctor appointment`
  );
});

bot.hears("📞 Schedule Call", async (ctx) => {
  await ctx.reply(
    `Use this format:

/call 2026-06-20 18:00 Project discussion`
  );
});

bot.hears("⏰ Reminder", async (ctx) => {
  await ctx.reply(
    `Use this format:

/remind 10m Submit assignment
/remind 2026-06-20 19:00 Pay fee`
  );
});

bot.hears("✅ Todo List", async (ctx) => {
  await ctx.reply(
    `Use these commands:

/todo add Learn Telegraf
/todo list
/todo done 1
/todo delete 1`
  );
});

bot.hears("📍 Location", async (ctx) => {
  await ctx.replyWithLocation(15.5553, 73.7517);
});

bot.hears("🤖 Ask AI", async (ctx) => {
  await ctx.reply("Type any question and I will answer using Gemini AI.");
});

// AI fallback for normal text
bot.on("text", async (ctx) => {
  const text = ctx.message.text;

  if (text.startsWith("/")) {
    return ctx.reply("Unknown command. Use /help to see available commands.");
  }

  try {
    await ctx.sendChatAction("typing");

    const answer = await askGemini(text);

    await ctx.reply(answer);
  } catch (error) {
    console.log("Gemini error:", error.message);

    await ctx.reply(
      "AI service is currently not responding. Please check Gemini API key, model name, or quota."
    );
  }
});

// Global bot error handler
bot.catch((error, ctx) => {
  console.log("Bot error:", error.message);
});

// Start bot
async function startBot() {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Start bot" },
    { command: "help", description: "Show help menu" },
    { command: "location", description: "Send location" },
    { command: "appointment", description: "Book appointment" },
    { command: "appointments", description: "View appointments" },
    { command: "call", description: "Schedule call" },
    { command: "calls", description: "View scheduled calls" },
    { command: "remind", description: "Set reminder" },
    { command: "reminders", description: "View reminders" },
    { command: "todo", description: "Manage todo list" },
  ]);

  await bot.launch();
}

// Start Express server and Telegram bot
async function startServer() {
  try {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Express server running on PORT ${PORT}`);
    });

    await startBot();

    console.log("Telegram bot is running...");
  } catch (error) {
    console.log("Server start error:", error.message);
  }
}

startServer();

// Graceful stop
process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});