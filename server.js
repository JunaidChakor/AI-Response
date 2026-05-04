import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { promisify } from "node:util";
import libre from "libreoffice-convert";
import dotenv from "dotenv";

dotenv.config();

const TWELVELABS_API_KEY = "tlk_1ZH8HRF3JX8K122X1J4YR2CN4AJA";
const TWELVELABS_BASE_URL = "https://api.twelvelabs.io/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const libreConvertAsync = promisify(libre.convert);

const LIM = {
  v: 4 * 1024 * 1024 * 1024,  // 4GB for multipart upload (12Labs limit)
  r: 5 * 1024 * 1024,
  h: 10 * 1024 * 1024,
};

const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const ext = (n) => {
  const i = String(n || "").lastIndexOf(".");
  return i >= 0 ? String(n).slice(i).toLowerCase() : "";
};

const guessMime = (name, fallback) => MIME[ext(name)] || fallback || "application/octet-stream";

const normalizeUrl = (u) => {
  if (u == null) return "";
  let t = String(u).trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "false") return "";
  t = t.replace(/\s/g, "");
  t = t.replace(/^https?:https?:\/\//i, "https://");
  t = t.replace(/^http:\/https?:\/\//i, "https://");
  t = t.replace(/^https?:\/\/https?:\/\//i, "https://");
  if (t.startsWith("//")) return "https:" + t;
  if (!/^https?:\/\//i.test(t)) t = "https://" + t.replace(/^\/+/, "");
  try {
    const parsed = new URL(t);
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host || host === "null" || host === "undefined" || host === "none" || host === "false") return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

const s = (v) => (v == null ? "" : String(v).replace(/\0/g, ""));
const cleanApiKey = (v) => {
  if (v == null) return "";
  const t = String(v).trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "false") return "";
  return t;
};
const cleanOptionalUrl = (v) => {
  if (v == null) return "";
  const t = String(v).trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "false") return "";
  return t;
};

const MEDIA_ACCESS_TOKEN = cleanApiKey(process.env.MEDIA_ACCESS_TOKEN) || "";

function withMediaToken(url, token, tokenKey = "token") {
  const abs = normalizeUrl(url);
  if (!abs || !token) return abs;

  try {
    const parsed = new URL(abs);
    parsed.searchParams.set(tokenKey || "token", token);
    return parsed.toString();
  } catch {
    const sep = abs.includes("?") ? "&" : "?";
    return `${abs}${sep}${encodeURIComponent(tokenKey || "token")}=${encodeURIComponent(token)}`;
  }
}

function mediaFetchOpts(authToken = MEDIA_ACCESS_TOKEN) {
  const token = cleanOptionalUrl(authToken);
  if (!token) return fetchOpts;
  return {
    ...fetchOpts,
    headers: {
      ...fetchOpts.headers,
      Authorization: `Bearer ${token}`,
    },
  };
}

const fetchOpts = {
  redirect: "follow",
  headers: { "User-Agent": "CastingRenderService-TwelveLabs/1" },
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 180000, label = "http-request") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function logError(stage, err, context = {}) {
  const message = String(err?.message || err);
  const stack = err?.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : "";
  console.error(`[error] ${stage}: ${message}`);
  if (Object.keys(context).length) {
    try {
      console.error("[error-context]", JSON.stringify(context));
    } catch {
      console.error("[error-context]", context);
    }
  }
  if (stack) console.error(stack);
}

function parseJsonSafe(raw, label) {
  let t = String(raw ?? "").trim();
  if (!t) throw new Error(`${label}: empty body`);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch (e1) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch (e2) {
        /* fall through */
      }
    }
    throw new Error(`${label}: ${e1.message}. Snippet: ${t.slice(0, 200)}`);
  }
}

async function fetchBinary(url, authToken = MEDIA_ACCESS_TOKEN) {
  let abs = normalizeUrl(url);
  console.log("[fetchBinary] Fetching:", abs);
  if (!abs) throw new Error("Missing file URL");

  // For Bubble URLs, add token as query parameter AND Bearer auth header
  const isBubbleUrl = abs.includes("bubble.io");
  if (isBubbleUrl && authToken && authToken.trim()) {
    abs = withMediaToken(abs, authToken, "token");
    console.log("[fetchBinary] Added token to Bubble URL");
  }

  const t0 = Date.now();
  const opts = mediaFetchOpts(authToken);
  
  const res = await fetchWithTimeout(abs, opts, 45 * 60 * 1000, "fetchBinary:request");
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${abs}`);

  console.log(`[fetchBinary] response headers received url=${abs}`);
  const ab = await res.arrayBuffer();
  let name = "file";

  try {
    const parsed = new URL(abs);
    const last = parsed.pathname.split("/").pop();
    if (last) name = decodeURIComponent(last.split("?")[0]);
  } catch {}

  const buffer = Buffer.from(ab);
  const elapsed = Date.now() - t0;
  console.log(`[fetchBinary] completed url=${abs} bytes=${buffer.length} elapsed_ms=${elapsed}`);
  return { buffer, name, size: buffer.length };
}

async function indexVideoWith12Labs(videoBuffer, videoName) {
  console.log("[12labs] Uploading video for indexing...");
  
  // Create FormData for multipart upload
  const formData = new FormData();
  const blob = new Blob([videoBuffer], { type: "video/mp4" });
  formData.append("file", blob, videoName);
  formData.append("index_name", `casting-${uuidv4()}`);
  
  try {
    const uploadRes = await fetchWithTimeout(
      `${TWELVELABS_BASE_URL}/indexes/tasks/index`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TWELVELABS_API_KEY}`,
        },
        body: formData,
      },
      45 * 60 * 1000,
      "12labs:index"
    );

    const uploadText = await uploadRes.text();
    console.log(`[12labs] index response status=${uploadRes.status}`);

    if (!uploadRes.ok) {
      throw new Error(`12Labs index failed ${uploadRes.status}: ${uploadText.slice(0, 800)}`);
    }

    let uploadJson;
    try {
      uploadJson = parseJsonSafe(uploadText, "12labs-index");
    } catch (e) {
      throw new Error(`Invalid 12Labs response: ${e.message}`);
    }

    const taskId = uploadJson.task_id || uploadJson.id;
    if (!taskId) throw new Error(`No task_id in 12Labs response: ${uploadText.slice(0, 400)}`);

    console.log(`[12labs] task_id=${taskId}`);
    return taskId;
  } catch (e) {
    logError("12labs-index", e);
    throw e;
  }
}

async function waitFor12LabsTask(taskId, maxWaitMs = 15 * 60 * 1000) {
  console.log(`[12labs] Waiting for task ${taskId} to complete...`);
  const t0 = Date.now();
  
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const statusRes = await fetchWithTimeout(
        `${TWELVELABS_BASE_URL}/tasks/${taskId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${TWELVELABS_API_KEY}`,
          },
        },
        30000,
        "12labs:status"
      );

      const statusText = await statusRes.text();
      if (!statusRes.ok) {
        console.error(`[12labs] status check failed ${statusRes.status}: ${statusText.slice(0, 500)}`);
        await sleep(5000);
        continue;
      }

      let statusJson;
      try {
        statusJson = parseJsonSafe(statusText, "12labs-status");
      } catch (e) {
        console.error(`[12labs] parse error: ${e.message}`);
        await sleep(5000);
        continue;
      }

      const status = statusJson.status || statusJson.state;
      console.log(`[12labs] task status=${status}`);

      if (status === "SUCCEEDED" || status === "completed") {
        console.log(`[12labs] task completed`);
        return statusJson;
      }

      if (status === "FAILED" || status === "error") {
        throw new Error(`Task failed: ${statusText}`);
      }

      await sleep(5000);
    } catch (e) {
      logError("12labs-wait", e);
      await sleep(5000);
    }
  }

  throw new Error("Timeout waiting for 12Labs task completion");
}

async function queryVideoWith12Labs(videoId, prompt) {
  console.log("[12labs] Querying video with casting prompt...");
  
  const queryPayload = {
    video_id: videoId,
    prompt: prompt,
  };

  try {
    const queryRes = await fetchWithTimeout(
      `${TWELVELABS_BASE_URL}/search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TWELVELABS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(queryPayload),
      },
      60000,
      "12labs:query"
    );

    const queryText = await queryRes.text();
    console.log(`[12labs] query response status=${queryRes.status}`);

    if (!queryRes.ok) {
      throw new Error(`12Labs query failed ${queryRes.status}: ${queryText.slice(0, 800)}`);
    }

    let queryJson;
    try {
      queryJson = parseJsonSafe(queryText, "12labs-query");
    } catch (e) {
      throw new Error(`Invalid 12Labs query response: ${e.message}`);
    }

    return queryJson;
  } catch (e) {
    logError("12labs-query", e);
    throw e;
  }
}

function buildCastingPrompt(p) {
  const roleCharsText = (rc) => {
    try {
      if (rc == null) return "";
      if (Array.isArray(rc)) return rc.map((x) => s(x)).join("\n");
      return s(rc);
    } catch {
      return "";
    }
  };

  const headshotText = p.headshot_url ? normalizeUrl(p.headshot_url) : "";
  const drive = p.drive_folder_link ? normalizeUrl(p.drive_folder_link) : "";

  return `You are an expert casting evaluator for film and streaming projects.

Task: Analyze the full audition video from start to end, then return a strict JSON decision for casting.

Critical rules:
1. You must always return all required keys: ai_score, overall_assessment, strengths, considerations, recommendation.
2. ai_score must be an integer from 0 to 100.
3. strengths and considerations must be arrays of short strings.
4. recommendation must be exactly one of: callback, hold_for_more_material, not_a_fit.
5. Do not output markdown or any text outside JSON.

Project and role data:
Project Title: ${s(p.PROJECT_TITLE)}
Project Overview: ${s(p.project_overview)}
Casting For: ${s(p.casting_for)}

Role Type: ${s(p.role_type)}
Role Gender: ${s(p.role_gender)}
Role Description: ${s(p.role_description)}
Role Requirements: ${s(p.role_requirements)}
Role Characteristics: ${roleCharsText(p.role_characteristics)}
Age Range: ${s(p.age_range)}
Location: ${s(p.location)} (role)
Minimum Height: ${s(p.minimum_height)}
Maximum Height: ${s(p.maximum_height)}
Minimum AI Score: ${s(p.minimum_ai_score)}

Applicant data:
Gender: ${s(p.user_gender)}
Age: ${s(p.user_age)}
Location: ${s(p.user_location)} (applicant)
Height: ${s(p.user_height)}
About: ${s(p.about_person)}
Bio: ${s(p.bio)}

Evaluation focus:
- Performance and presence: confidence, pacing, authenticity, camera connection
- Voice and speech: clarity, articulation, emotional tone
- Face and body: expression range, eye focus, posture, gesture control
- Role fit: alignment with role description and requirements
- Production readiness

Return ONLY this JSON structure with all fields present:
{
  "ai_score": 0,
  "overall_assessment": "",
  "strengths": [],
  "considerations": [],
  "recommendation": ""
}

Decision rules:
- If ai_score is below ${s(p.minimum_ai_score)}, recommendation must be not_a_fit.
- If evidence is limited, use hold_for_more_material unless ai_score is very high.
- If role context is missing, cap ai_score at 70.`;
}

async function analyzeCastingWith12Labs(properties) {
  const p = properties || {};
  const videoUrl = normalizeUrl(p.video_url);

  if (!videoUrl) throw new Error("video_url required");

  console.log(`[casting] Starting 12Labs analysis for video: ${videoUrl}`);

  // Fetch video
  const vf = await fetchBinary(videoUrl, MEDIA_ACCESS_TOKEN);
  if (vf.size > LIM.v) throw new Error("Video too large");

  // Index with 12Labs
  const taskId = await indexVideoWith12Labs(vf.buffer, vf.name || "audition.mp4");

  // Wait for indexing
  const taskResult = await waitFor12LabsTask(taskId);
  const videoId = taskResult.video_id || taskResult.id;

  if (!videoId) {
    throw new Error(`No video_id returned from 12Labs: ${JSON.stringify(taskResult)}`);
  }

  console.log(`[casting] Video indexed with ID: ${videoId}`);

  // Build prompt
  const prompt = buildCastingPrompt(p);

  // Query with casting prompt
  const queryResult = await queryVideoWith12Labs(videoId, prompt);
  console.log(`[casting] Query result:`, JSON.stringify(queryResult).slice(0, 500));

  // Extract and parse the response
  let parsed;
  const responseText = queryResult.summary || queryResult.text || JSON.stringify(queryResult);

  try {
    parsed = parseJsonSafe(responseText, "12labs-casting-output");
  } catch (e) {
    console.error(`[casting] Parse error, creating fallback response`);
    parsed = {
      ai_score: 0,
      overall_assessment: "12Labs analysis could not be fully parsed. Review video manually.",
      strengths: [],
      considerations: ["Response parsing incomplete"],
      recommendation: "hold_for_more_material",
    };
  }

  // Normalize response
  const toStrList = (v) => (Array.isArray(v) ? v.map((x) => s(x)) : v == null ? [] : [s(v)]);
  const rawScore = Number(parsed.ai_score);
  const aiScore = Number.isFinite(rawScore) ? Math.round(Math.max(0, Math.min(100, rawScore))) : 0;

  return {
    overall_assessment: s(parsed.overall_assessment || ""),
    strengths: toStrList(parsed.strengths),
    considerations: toStrList(parsed.considerations),
    recommendation: s(parsed.recommendation || "hold_for_more_material"),
    ai_score: aiScore,
  };
}

async function sendBubbleCallback(payload, callbackUrl) {
  const requestedCallbackUrl = cleanOptionalUrl(callbackUrl);
  const configuredDefaultCallbackUrl = cleanOptionalUrl(process.env.BUBBLE_CALLBACK_URL);
  const baseUrl = normalizeUrl(requestedCallbackUrl || configuredDefaultCallbackUrl);

  if (!baseUrl) {
    console.log("[callback] No callback URL, skipping");
    return;
  }

  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[callback] attempt=${attempt}/${maxAttempts} url=${baseUrl}`);
      const res = await fetchWithTimeout(
        baseUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        30000,
        "bubble-callback"
      );

      if (res.ok) {
        console.log(`[callback] success status=${res.status}`);
        return;
      }

      const t = await res.text();
      console.error(`[callback] non-ok status=${res.status} body=${t.slice(0, 500)}`);
      lastErr = new Error(`Callback failed ${res.status}`);
    } catch (e) {
      logError("callback-attempt", e, { attempt });
      lastErr = e;
    }

    if (attempt < maxAttempts) {
      await sleep(2000);
    }
  }

  if (lastErr) {
    console.error(`[callback] Failed after retries: ${lastErr.message}`);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const jobs = new Map();
let activeWorkers = 0;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "casting-render-service-twelvelabs" });
});

app.post("/jobs", (req, res) => {
  const jobId = uuidv4();
  const payload = req.body || {};

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
  });

  res.status(200).json({ ok: true, status: "accepted", jobId });

  // Process async
  (async () => {
    try {
      activeWorkers += 1;
      console.log(`[jobs] start id=${jobId} application_id=${payload?.application_id ?? ""}`);
      jobs.set(jobId, { ...jobs.get(jobId), status: "processing", startedAt: new Date().toISOString() });

      const result = await analyzeCastingWith12Labs(payload);
      const curr = jobs.get(jobId);

      if (curr) {
        jobs.set(jobId, {
          ...curr,
          status: "completed",
          completedAt: new Date().toISOString(),
          result,
        });
      }

      console.log(`[jobs] completed id=${jobId} score=${result.ai_score}`);

      await sendBubbleCallback(
        {
          status: "completed",
          application_id: payload.application_id ?? null,
          video_link: payload.video_link ?? payload.video_url ?? null,
          ...result,
        },
        payload.callback_url
      );
    } catch (err) {
      logError("job-processing", err, { jobId, application_id: payload?.application_id });

      const fallbackResult = {
        overall_assessment: "12Labs evaluation could not be completed. Please retry.",
        strengths: [],
        considerations: ["Service temporarily unavailable"],
        recommendation: "hold_for_more_material",
        ai_score: 0,
        error: String(err?.message || err),
        is_fallback: true,
      };

      const curr = jobs.get(jobId);
      if (curr) {
        jobs.set(jobId, {
          ...curr,
          status: "completed_with_fallback",
          completedAt: new Date().toISOString(),
          result: fallbackResult,
          error: String(err?.message || err),
        });
      }

      try {
        await sendBubbleCallback(
          {
            status: "completed_with_fallback",
            application_id: payload.application_id ?? null,
            video_link: payload.video_link ?? payload.video_url ?? null,
            ...fallbackResult,
          },
          payload.callback_url
        );
      } catch (cbErr) {
        logError("callback-failure", cbErr, { jobId });
      }
    } finally {
      activeWorkers = Math.max(0, activeWorkers - 1);
    }
  })();
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "casting-render-service-twelvelabs",
    active_workers: activeWorkers,
    jobs_tracked: jobs.size,
  });
});

const PORT = process.env.PORT_12LABS || 10001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[12Labs] Server running on port ${PORT}`);
});
