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

// ============================================================
// GEMINI CONFIG
// ============================================================

const AI_CONFIG = {
  model: "gemini-3.6-flash",

  // AI role + permanent behavior
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

  // Controls applied to each interaction
  generationConfig: {
    max_output_tokens: 1000,
    thinking_level: "low",
  },

  // Don't persist conversations unless required.
  store: false,

  // Protect backend from unnecessarily large prompts.
  maxInputTokens: 1000,
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

app.use(express.json({
  limit: MAX_BODY_SIZE,
}));


// ============================================================
// GEMINI SERVICE
// ============================================================

async function generateGeminiResponse(prompt) {
  const interaction = await ai.interactions.create({
    model: AI_CONFIG.model,

    system_instruction:
      AI_CONFIG.systemInstruction,

    input: prompt,

    generation_config:
      AI_CONFIG.generationConfig,

    store: AI_CONFIG.store,
  });

  return {
    answer: interaction.output_text || "",
    usage: interaction.usage || {},
    interactionId: interaction.id,
  };
}


// ============================================================
// TOKEN COUNTING
// ============================================================
//
// Don't call countTokens() for every request.
// That creates an additional API operation.
//
// We only count tokens when the prompt is large enough
// to potentially require protection.
// ============================================================

async function validateInputSize(prompt) {
  const INPUT_CHECK_THRESHOLD = 12000;

  // Small prompts don't need a separate token-count request.
  if (prompt.length < INPUT_CHECK_THRESHOLD) {
    return {
      valid: true,
      tokenCount: null,
    };
  }

  const result = await ai.models.countTokens({
    model: AI_CONFIG.model,
    contents: prompt,
  });

  const tokenCount = result.totalTokens;

  return {
    valid: tokenCount <= AI_CONFIG.maxInputTokens,
    tokenCount,
  };
}


// ============================================================
// NORMALIZE TOKEN USAGE
// ============================================================

function getUsage(usage = {}) {
  return {
    input_tokens:
      usage.total_input_tokens ?? 0,

    output_tokens:
      usage.total_output_tokens ?? 0,

    thought_tokens:
      usage.total_thought_tokens ?? 0,

    cached_tokens:
      usage.total_cached_tokens ?? 0,

    tool_tokens:
      usage.total_tool_use_tokens ?? 0,

    total_tokens:
      usage.total_tokens ?? 0,
  };
}


// ============================================================
// API ROUTE
// ============================================================

app.post("/api/ask", async (req, res) => {
  try {
    const prompt = req.body?.prompt?.trim();

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required",
      });
    }

    // --------------------------------------------------------
    // TOKEN PROTECTION
    // --------------------------------------------------------

    const inputValidation =
      await validateInputSize(prompt);

    if (!inputValidation.valid) {
      return res.status(400).json({
        success: false,
        error:
          `Prompt is too large. Maximum allowed input is ` +
          `${AI_CONFIG.maxInputTokens} tokens.`,

        estimated_input_tokens:
          inputValidation.tokenCount,
      });
    }

    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    const result =
      await generateGeminiResponse(prompt);

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.json({
      success: true,

      answer: result.answer,

      usage: getUsage(result.usage),

      ...(inputValidation.tokenCount !== null && {
        estimated_input_tokens:
          inputValidation.tokenCount,
      }),
    });

  } catch (error) {
    console.error("Gemini API Error:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Failed to generate Gemini response",
    });
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

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <title>Gemini AI</title>

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      font-family: system-ui, sans-serif;
      max-width: 750px;
      margin: 50px auto;
      padding: 0 20px;
      color: #222;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      padding: 14px;
      border: 1px solid #ccc;
      border-radius: 8px;
      resize: vertical;
      font-size: 16px;
    }

    button {
      margin-top: 12px;
      padding: 12px 20px;
      border: 0;
      border-radius: 7px;
      background: #007bff;
      color: white;
      font-size: 16px;
      cursor: pointer;
    }

    button:disabled {
      background: #999;
      cursor: not-allowed;
    }

    #loading {
      display: none;
      margin-top: 15px;
      color: #666;
    }

    #result,
    #usage {
      display: none;
      margin-top: 20px;
      padding: 16px;
      border-radius: 8px;
      white-space: pre-wrap;
    }

    #result {
      background: #f8f9fa;
      border: 1px solid #e5e5e5;
      line-height: 1.6;
    }

    #usage {
      background: #f1f3f5;
      font-size: 14px;
    }

    .error {
      color: #d93025;
    }

  </style>

</head>


<body>

  <h1>Ask Gemini</h1>

  <textarea
    id="prompt"
    placeholder="Enter your question..."
  ></textarea>

  <button id="askButton">
    Ask Gemini
  </button>

  <div id="loading">
    Gemini is thinking...
  </div>

  <div id="result"></div>

  <div id="usage"></div>


  <script>

    const promptInput =
      document.getElementById("prompt");

    const askButton =
      document.getElementById("askButton");

    const loading =
      document.getElementById("loading");

    const result =
      document.getElementById("result");

    const usage =
      document.getElementById("usage");


    askButton.addEventListener(
      "click",
      askGemini
    );


    async function askGemini() {

      const prompt =
        promptInput.value.trim();

      if (!prompt) {
        return;
      }


      setLoading(true);

      result.style.display = "none";
      usage.style.display = "none";


      try {

        const response =
          await fetch("/api/ask", {

            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              prompt,
            }),

          });


        const data =
          await response.json();


        if (!response.ok) {
          throw new Error(
            data.error ||
            "Gemini request failed"
          );
        }


        result.textContent =
          data.answer || "No response";

        result.style.display = "block";


        if (data.usage) {

          usage.textContent =
            formatUsage(data.usage);

          usage.style.display = "block";
        }


      } catch (error) {

        result.innerHTML =
          '<span class="error">' +
          escapeHtml(error.message) +
          "</span>";

        result.style.display = "block";

      } finally {

        setLoading(false);

      }

    }


    function setLoading(isLoading) {

      askButton.disabled = isLoading;

      loading.style.display =
        isLoading
          ? "block"
          : "none";

    }


    function formatUsage(usage) {

      return [
        "Token Usage",
        "",
        "Input: " +
          usage.input_tokens,

        "Output: " +
          usage.output_tokens,

        "Thinking: " +
          usage.thought_tokens,

        "Cached: " +
          usage.cached_tokens,

        "Tools: " +
          usage.tool_tokens,

        "Total: " +
          usage.total_tokens,

      ].join("\\n");

    }


    function escapeHtml(value) {

      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    }

  </script>

</body>

</html>
  `);
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `🚀 Server: http://localhost:${PORT}`
  );

  console.log(
    `🤖 Model: ${AI_CONFIG.model}`
  );

  console.log(
    `🧠 Thinking: ${AI_CONFIG.generationConfig.thinking_level}`
  );

  console.log(
    `📦 Max output tokens: ${
      AI_CONFIG.generationConfig.max_output_tokens
    }`
  );

});