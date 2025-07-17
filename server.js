const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 你的 OpenAI 代理配置
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sb-aae83eeff3fded8a5acad0ae2aba409d61ad571cf1d9b025";
const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai-sb.com/v1/chat/completions";

// 存储前端同步过来的 readable/action
let readables = [];
let actions = [];

// 前端同步 readable/action
app.post("/sync", (req, res) => {
  readables = req.body.readables || [];
  actions = req.body.actions || [];
  res.json({ status: "ok" });
});

// SSE 聊天接口
app.post("/chat-stream", async (req, res) => {
  const userMessage = req.body.message.trim();

  // 设置 SSE 头部
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  const prompt = `
You are an assistant for a project management system. Your behavior must strictly follow these rules:

1. If the user's question can be answered directly using the provided project data (see below, called "readables"), DO NOT call any function/action. Just answer using the data.
2. Only call an action (function) if the user explicitly asks you to perform an operation, such as add, delete, update, or get a specific item by id, or if the user's request cannot be fulfilled by the readables alone.
3. When choosing an action, you must select the one whose description and parameters best match the user's intent. Do not call unrelated actions. Never call a greeting or default action unless the user clearly requests it.
4. If the user's question is not related to the project data or available actions, reply with: "I'm only able to answer questions about the project data and available actions."
5. If the user asks to list, summarize, filter, or analyze data that is present in the readables, always use the readables directly and do not call any action.
6. If the user asks for a specific operation (such as add, remove, update, or get by id), only call the action that exactly matches the operation and parameters described by the user.
7. When matching user intent to available actions or readables, always strictly match the entity type (e.g., "employee" vs "product"). Never use an employee-related action to answer a product-related question, and vice versa. If the user's request can be answered by a readable (such as the list of products), always use the readable directly and do not call any action.
Here is the current application state (readables):
${readables.map((r) => `- ${r.description}: ${JSON.stringify(r.value)}`).join("\n")}
`;

  // OpenAI function calling tools
  const functions = actions.map((a) => ({
    name: a.name,
    description: a.description,
    parameters: a.parameters,
  }));

  try {
    // 发送 thinking 状态
    res.write(`data: ${JSON.stringify({ type: "thinking", message: "正在分析您的请求..." })}\n\n`);

    // 组装 OpenAI Chat API 请求体 - 使用流式响应
    const requestBody = {
      model: "gpt-3.5-turbo-1106",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userMessage },
      ],
      functions,
      function_call: "auto",
      stream: true, // 启用流式响应
    };

    const response = await axios.post(OPENAI_API_URL, requestBody, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
    });

    let fullContent = "";
    let functionCall = null;

    response.data.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            // 流结束
            if (functionCall) {
              res.write(`data: ${JSON.stringify({ type: "function_call", functionCall })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ type: "complete", content: fullContent })}\n\n`);
            }
            res.end();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices[0]) {
              const choice = parsed.choices[0];

              if (choice.delta && choice.delta.content) {
                fullContent += choice.delta.content;
                // 发送流式内容
                res.write(`data: ${JSON.stringify({ type: "content", content: choice.delta.content })}\n\n`);
              }

              if (choice.delta && choice.delta.function_call) {
                if (!functionCall) {
                  functionCall = { name: "", arguments: "" };
                }
                if (choice.delta.function_call.name) {
                  functionCall.name += choice.delta.function_call.name;
                }
                if (choice.delta.function_call.arguments) {
                  functionCall.arguments += choice.delta.function_call.arguments;
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    });

    response.data.on("error", (error) => {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// 兼容原有的聊天接口
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message.trim();

  const prompt = `
You are an assistant for a project management system. Your behavior must strictly follow these rules:

1. If the user's question can be answered directly using the provided project data (see below, called "readables"), DO NOT call any function/action. Just answer using the data.
2. Only call an action (function) if the user explicitly asks you to perform an operation, such as add, delete, update, or get a specific item by id, or if the user's request cannot be fulfilled by the readables alone.
3. When choosing an action, you must select the one whose description and parameters best match the user's intent. Do not call unrelated actions. Never call a greeting or default action unless the user clearly requests it.
4. If the user's question is not related to the project data or available actions, reply with: "I'm only able to answer questions about the project data and available actions."
5. If the user asks to list, summarize, filter, or analyze data that is present in the readables, always use the readables directly and do not call any action.
6. If the user asks for a specific operation (such as add, remove, update, or get by id), only call the action that exactly matches the operation and parameters described by the user.
7. When matching user intent to available actions or readables, always strictly match the entity type (e.g., "employee" vs "product"). Never use an employee-related action to answer a product-related question, and vice versa. If the user's request can be answered by a readable (such as the list of products), always use the readable directly and do not call any action.
Here is the current application state (readables):
${readables.map((r) => `- ${r.description}: ${JSON.stringify(r.value)}`).join("\n")}
`;

  // OpenAI function calling tools
  const functions = actions.map((a) => ({
    name: a.name,
    description: a.description,
    parameters: a.parameters,
  }));

  // 组装 OpenAI Chat API 请求体
  const requestBody = {
    model: "gpt-3.5-turbo-1106", // 或 "gpt-4-1106-preview" 视代理支持情况
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userMessage },
    ],
    functions,
    function_call: "auto",
  };

  try {
    const response = await axios.post(OPENAI_API_URL, requestBody, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    // 检查 OpenAI 是否要调用 action
    const choice = response.data.choices[0];
    if (choice.finish_reason === "function_call" || choice.message.function_call) {
      // function_call 结构
      const { name, arguments: args } = choice.message.function_call;
      res.json({
        toolCalls: [
          {
            functionCall: {
              name,
              args: JSON.parse(args),
            },
          },
        ],
      });
    } else {
      res.json({ text: choice.message.content });
    }
  } catch (err) {
    return res.status(500).json({ error: "OpenAI API error", details: err.response?.data || err.message });
  }
});

// 前端执行完 action 后反馈结果
app.post("/action-result", (req, res) => {
  // 这里只做演示，实际可将结果继续反馈给 OpenAI
  res.json({ status: "received", result: req.body });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
