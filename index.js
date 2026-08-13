import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

// ============================================================
// APP CONFIG
// ============================================================

const app = express();

const PORT = process.env.PORT || 3000;

const MAX_BODY_SIZE = "32kb";
const MAX_INPUT_TOKENS = 1000;
const MAX_OUTPUT_TOKENS = 4000;

// ============================================================
// GEMINI CONFIG
// ============================================================
// NOTE: "gemini-3.6-flash" is not a real model name in the current
// Gemini lineup, so this uses "gemini-2.5-flash", a real, current
// model. Swap it for whatever model your API key has access to.

const AI_CONFIG = {
  model: "gemini-3.6-flash",

  systemInstruction: `
You are a helpful and accurate AI assistant.

Rules:
- Understand the user's request before answering.
- Give practical and production-ready answers.
- Keep answers concise unless detail is requested.
- For programming questions, provide clear examples.
- Do not invent APIs, functions, libraries, or facts.
- If you are uncertain, say so.
- Use Markdown when useful.
- Prioritize correctness over creativity.
`,

  generationConfig: {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  },
};

// ============================================================
// VALIDATE ENVIRONMENT
// ============================================================

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

// ============================================================
// GEMINI CLIENT
// ============================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  express.json({
    limit: MAX_BODY_SIZE,
  })
);

// ============================================================
// HELPERS
// ============================================================

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  return (
    error?.message ||
    error?.error?.message ||
    error?.response?.data?.error?.message ||
    "Unknown Gemini API error"
  );
}

// ============================================================
// NORMALIZE USAGE
// ============================================================
// The real SDK returns usage on `response.usageMetadata` (for
// generateContent) and on the final chunk's `.usageMetadata` (for
// generateContentStream), with fields like promptTokenCount,
// candidatesTokenCount, totalTokenCount, thoughtsTokenCount,
// cachedContentTokenCount.

function getUsage(usageMetadata = {}) {
  return {
    input_tokens: usageMetadata.promptTokenCount ?? 0,
    output_tokens: usageMetadata.candidatesTokenCount ?? 0,
    thought_tokens: usageMetadata.thoughtsTokenCount ?? 0,
    cached_tokens: usageMetadata.cachedContentTokenCount ?? 0,
    total_tokens: usageMetadata.totalTokenCount ?? 0,
  };
}

// ============================================================
// VALIDATE PROMPT
// ============================================================

function validatePrompt(prompt) {
  if (typeof prompt !== "string") {
    return {
      valid: false,
      error: "Prompt must be a string.",
    };
  }

  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return {
      valid: false,
      error: "Prompt is required.",
    };
  }

  return {
    valid: true,
    prompt: trimmedPrompt,
  };
}

// ============================================================
// GEMINI DIRECT RESPONSE
// ============================================================

async function generateGeminiResponse(prompt) {
  const response = await ai.models.generateContent({
    model: AI_CONFIG.model,

    contents: prompt,

    config: {
      systemInstruction: AI_CONFIG.systemInstruction,
      maxOutputTokens: AI_CONFIG.generationConfig.maxOutputTokens,
    },
  });

  return {
    answer: response?.text || "",
    usage: getUsage(response?.usageMetadata || {}),
  };
}

// ============================================================
// SSE HELPERS
// ============================================================

function setupSSE(res) {
  res.status(200);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  if (typeof res.socket?.setKeepAlive === "function") {
    res.socket.setKeepAlive(true);
  }
}

function sendSSE(res, data) {
  if (res.writableEnded) {
    return;
  }

  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ============================================================
// DIRECT API
// ============================================================

app.post("/api/ask", async (req, res) => {
  try {
    const validation = validatePrompt(req.body?.prompt);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const prompt = validation.prompt;

    // --------------------------------------------------------
    // TOKEN COUNT
    // --------------------------------------------------------

    const tokenResult = await ai.models.countTokens({
      model: AI_CONFIG.model,
      contents: prompt,
    });

    const inputTokens = tokenResult?.totalTokens ?? 0;

    if (inputTokens > MAX_INPUT_TOKENS) {
      return res.status(400).json({
        success: false,

        error:
          `Prompt is too large. ` +
          `Maximum allowed input is ` +
          `${MAX_INPUT_TOKENS} tokens.`,

        estimated_input_tokens: inputTokens,
        max_input_tokens: MAX_INPUT_TOKENS,
      });
    }

    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    const result = await generateGeminiResponse(prompt);

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.json({
      success: true,
      answer: result.answer || "No response generated.",
      usage: result.usage,
      estimated_input_tokens: inputTokens,
    });
  } catch (error) {
    console.error("❌ Gemini API Error:", error);

    return res.status(500).json({
      success: false,
      error: getErrorMessage(error),
    });
  }
});

// ============================================================
// STREAMING API
// ============================================================

app.post("/api/ask/stream", async (req, res) => {
  console.log("📡 /api/ask/stream called");

  const prompt = req.body?.prompt?.trim();

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: "Prompt is required",
    });
  }

  // ==========================================================
  // ESTABLISH SSE IMMEDIATELY
  // ==========================================================

  setupSSE(res);

  sendSSE(res, { type: "start" });

  console.log("📡 SSE connection established");

  let clientDisconnected = false;

  req.on("close", () => {
    clientDisconnected = true;
    console.log("🔌 Client disconnected");
  });

  try {
    // ========================================================
    // TOKEN COUNT (kept consistent with /api/ask)
    // ========================================================

    const tokenResult = await ai.models.countTokens({
      model: AI_CONFIG.model,
      contents: prompt,
    });

    const inputTokens = tokenResult?.totalTokens ?? 0;

    if (inputTokens > MAX_INPUT_TOKENS) {
      sendSSE(res, {
        type: "error",
        error:
          `Prompt is too large. ` +
          `Maximum allowed input is ` +
          `${MAX_INPUT_TOKENS} tokens.`,
      });

      return res.end();
    }

    // ========================================================
    // GEMINI STREAM
    // ========================================================

    console.log("🤖 Starting Gemini stream...");

    const stream = await ai.models.generateContentStream({
      model: AI_CONFIG.model,

      contents: prompt,

      config: {
        systemInstruction: AI_CONFIG.systemInstruction,
        maxOutputTokens: AI_CONFIG.generationConfig.maxOutputTokens,
      },
    });

    console.log("✅ Gemini stream created");

    let finalUsage = {};

    // ========================================================
    // READ GEMINI STREAM
    // ========================================================

    for await (const chunk of stream) {
      if (clientDisconnected) {
        break;
      }

      const text = chunk?.text || "";

      if (text) {
        sendSSE(res, {
          type: "text",
          text,
        });
      }

      // The usage metadata typically arrives fully populated on
      // the last chunk; keep overwriting so we end with the latest.
      if (chunk?.usageMetadata) {
        finalUsage = getUsage(chunk.usageMetadata);
      }
    }

    if (!clientDisconnected) {
      sendSSE(res, {
        type: "done",
        usage: finalUsage,
        estimated_input_tokens: inputTokens,
      });
    }

    // ========================================================
    // CLOSE SSE
    // ========================================================

    if (!res.writableEnded) {
      res.end();
    }

    console.log("🔌 SSE connection closed");
  } catch (error) {
    console.error("❌ STREAM ERROR:", error);

    if (!res.writableEnded) {
      sendSSE(res, {
        type: "error",
        error: getErrorMessage(error),
      });

      res.end();
    }
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "running",
    model: AI_CONFIG.model,
    max_input_tokens: MAX_INPUT_TOKENS,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });
});

// ============================================================
// FRONTEND
// ============================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini AI</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 20px;
      color: #222;
      background: #ffffff;
    }
    h1 { margin-bottom: 5px; }
    .subtitle { color: #666; margin-bottom: 25px; }
    textarea {
      width: 100%;
      min-height: 150px;
      padding: 14px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 8px;
      resize: vertical;
      outline: none;
      font-family: inherit;
    }
    textarea:focus { border-color: #007bff; }
    .buttons { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    button {
      padding: 11px 20px;
      border: none;
      border-radius: 7px;
      color: white;
      font-size: 15px;
      cursor: pointer;
    }
    #directButton { background: #007bff; }
    #streamButton { background: #198754; }
    #clearButton { background: #6c757d; }
    button:hover { opacity: 0.9; }
    button:disabled { background: #999; cursor: not-allowed; opacity: 0.7; }
    .answers { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
    .answer-card { border: 1px solid #ddd; border-radius: 10px; overflow: hidden; background: #fff; }
    .answer-header { padding: 12px 15px; font-weight: 600; border-bottom: 1px solid #ddd; }
    .direct-header { background: #eef6ff; color: #0066cc; }
    .stream-header { background: #eefbf3; color: #168047; }
    .answer-body {
      min-height: 250px;
      max-height: 600px;
      overflow-y: auto;
      padding: 16px;
      white-space: pre-wrap;
      line-height: 1.6;
      color: #333;
      word-break: break-word;
    }
    .placeholder { color: #999; font-style: italic; }
    .loading { display: none; margin-top: 15px; color: #666; font-size: 14px; }
    #usage {
      display: none;
      margin-top: 20px;
      padding: 15px;
      background: #f5f5f5;
      border-radius: 8px;
      white-space: pre-wrap;
      font-size: 14px;
    }
    .error { color: #d93025; }
    @media (max-width: 700px) {
      .answers { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <h1>Gemini AI</h1>
  <div class="subtitle">Direct response and real-time streaming response</div>

  <textarea id="prompt" placeholder="Ask Gemini something..."></textarea>

  <div class="buttons">
    <button id="directButton">Direct Response</button>
    <button id="streamButton">Stream Response</button>
    <button id="clearButton">Clear</button>
  </div>

  <div id="loading" class="loading">Gemini is thinking...</div>

  <div class="answers">
    <div class="answer-card">
      <div class="answer-header direct-header">Direct Answer</div>
      <div id="directResult" class="answer-body">
        <span class="placeholder">Direct response will appear here...</span>
      </div>
    </div>

    <div class="answer-card">
      <div class="answer-header stream-header">Streaming Answer</div>
      <div id="streamResult" class="answer-body">
        <span class="placeholder">Streaming response will appear here...</span>
      </div>
    </div>
  </div>

  <div id="usage"></div>

  <script>
    const promptInput = document.getElementById("prompt");
    const directButton = document.getElementById("directButton");
    const streamButton = document.getElementById("streamButton");
    const clearButton = document.getElementById("clearButton");
    const loading = document.getElementById("loading");
    const directResult = document.getElementById("directResult");
    const streamResult = document.getElementById("streamResult");
    const usage = document.getElementById("usage");

    async function directRequest() {
      const prompt = promptInput.value.trim();

      if (!prompt) {
        alert("Please enter a prompt.");
        return;
      }

      directResult.textContent = "Generating complete response...";
      usage.style.display = "none";
      setLoading(true);

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Direct request failed.");
        }

        directResult.textContent = data.answer || "No response generated.";

        if (data.usage) {
          showUsage("Direct Response Usage", data.usage, data.estimated_input_tokens);
        }
      } catch (error) {
        directResult.innerHTML =
          '<span class="error">' + escapeHtml(error.message) + "</span>";
      } finally {
        setLoading(false);
      }
    }

    async function streamRequest() {
      const prompt = promptInput.value.trim();

      if (!prompt) {
        alert("Please enter a prompt.");
        return;
      }

      streamResult.textContent = "";
      usage.style.display = "none";
      setLoading(true);

      try {
        const response = await fetch("/api/ask/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
          },
          body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Streaming request failed.");
        }

        if (!response.body) {
          throw new Error("Browser does not support streaming.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split(/\\r?\\n\\r?\\n/);
          buffer = events.pop() || "";

          for (const event of events) {
            processSSEEvent(event);
          }
        }

        buffer += decoder.decode();

        if (buffer.trim()) {
          processSSEEvent(buffer);
        }
      } catch (error) {
        streamResult.innerHTML +=
          '<span class="error">' + "\\n\\nError: " + escapeHtml(error.message) + "</span>";
      } finally {
        setLoading(false);
      }
    }

    function processSSEEvent(event) {
      const lines = event.split(/\\r?\\n/);

      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) {
        return;
      }

      const json = dataLines.join("\\n");

      if (!json || json === "[DONE]") {
        return;
      }

      let data;

      try {
        data = JSON.parse(json);
      } catch (error) {
        console.error("Invalid SSE JSON:", json, error);
        return;
      }

      if (data.type === "start") {
        return;
      }

      if (data.type === "text") {
        streamResult.textContent += data.text || "";
        streamResult.scrollTop = streamResult.scrollHeight;
        return;
      }

      if (data.type === "error") {
        throw new Error(data.error || "Streaming failed.");
      }

      if (data.type === "done") {
        showUsage("Streaming Response Usage", data.usage || {}, data.estimated_input_tokens);
        return;
      }
    }

    function setLoading(isLoading) {
      directButton.disabled = isLoading;
      streamButton.disabled = isLoading;
      loading.style.display = isLoading ? "block" : "none";
    }

    function showUsage(title, tokenUsage, estimatedInputTokens) {
      const lines = [
        title,
        "",
        "Input Tokens: " + (tokenUsage.input_tokens ?? 0),
        "Output Tokens: " + (tokenUsage.output_tokens ?? 0),
        "Thought Tokens: " + (tokenUsage.thought_tokens ?? 0),
        "Cached Tokens: " + (tokenUsage.cached_tokens ?? 0),
        "Total Tokens: " + (tokenUsage.total_tokens ?? 0),
      ];

      if (estimatedInputTokens !== undefined) {
        lines.push("", "Pre-request Input Tokens: " + estimatedInputTokens);
      }

      usage.textContent = lines.join("\\n");
      usage.style.display = "block";
    }

    function clearAll() {
      promptInput.value = "";

      directResult.innerHTML =
        '<span class="placeholder">Direct response will appear here...</span>';

      streamResult.innerHTML =
        '<span class="placeholder">Streaming response will appear here...</span>';

      usage.textContent = "";
      usage.style.display = "none";
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    directButton.addEventListener("click", directRequest);
    streamButton.addEventListener("click", streamRequest);
    clearButton.addEventListener("click", clearAll);

    promptInput.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key === "Enter") {
        directRequest();
      }
    });
  </script>
</body>
</html>
  `);
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("❌ Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: getErrorMessage(error),
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("======================================");
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`🤖 Model: ${AI_CONFIG.model}`);
  console.log(`📥 Max input tokens: ${MAX_INPUT_TOKENS}`);
  console.log(`📤 Max output tokens: ${MAX_OUTPUT_TOKENS}`);
  console.log("======================================");
  console.log("");
});