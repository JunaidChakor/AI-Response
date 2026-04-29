  import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { jsonrepair } from "jsonrepair";
import libre from "libreoffice-convert";
import { promisify } from "node:util";

const UP = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES = "https://generativelanguage.googleapis.com/v1beta/files";

const LIM = {
  v: 500 * 1024 * 1024,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const libreConvertAsync = promisify(libre.convert);
const DEFAULT_HTTP_TIMEOUT_MS = Math.max(5000, Number(process.env.HTTP_TIMEOUT_MS || 180000));
const MEDIA_HTTP_TIMEOUT_MS = Math.max(
  DEFAULT_HTTP_TIMEOUT_MS,
  Number(process.env.HTTP_MEDIA_TIMEOUT_MS || 45 * 60 * 1000)
);
const FILE_ACTIVE_TIMEOUT_MS = Math.max(600000, Number(process.env.FILE_ACTIVE_TIMEOUT_MS || 45 * 60 * 1000));

const cleanApiKey = (v) => {
  if (v == null) return "";
  const t = String(v).trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "false") return "";
  return t;
};

const MEDIA_ACCESS_TOKEN = cleanApiKey(process.env.MEDIA_ACCESS_TOKEN) || "";

const ext = (n) => {
  const i = String(n || "").lastIndexOf(".");
  return i >= 0 ? String(n).slice(i).toLowerCase() : "";
};

const guessMime = (name, fallback) => MIME[ext(name)] || fallback || "application/octet-stream";

const normalizeUrl = (u) => {
  if (u == null) return "";
  let t = String(u).trim();
  if (!t) return "";
  if (t.startsWith("//")) return "https:" + t;
  if (!/^https?:\/\//i.test(t)) return "https://" + t.replace(/^\/+/, "");
  return t;
};

const fetchOpts = {
  redirect: "follow",
  headers: { "User-Agent": "CastingRenderService/1" },
};

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, label = "http-request") {
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

async function readWithTimeout(promise, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, label = "http-read") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const s = (v) => (v == null ? "" : String(v).replace(/\0/g, ""));

const cleanOptionalUrl = (v) => {
  if (v == null) return "";
  const t = String(v).trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "none" || lower === "false") return "";
  return t;
};
const parseModelList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  const t = String(v || "").trim();
  if (!t) return [];
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => String(x || "").trim()).filter(Boolean);
    } catch {
      /* fall through to CSV parsing */
    }
  }
  return t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

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

/** Parse JSON from Gemini/HTTP bodies; strips BOM, markdown fences, or leading junk. */
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

const roleCharsText = (rc) => {
  try {
    if (rc == null) return "";
    if (Array.isArray(rc)) return rc.map((x) => s(x)).join("\n");
    return s(rc);
  } catch {
    return "";
  }
};

async function fetchBinary(url, authToken = "") {
  const abs = normalizeUrl(url);
  console.log("Fetching:", abs);
  if (!abs) throw new Error("Missing file URL");

  const t0 = Date.now();
  const opts = { ...fetchOpts };
  if (authToken) {
    opts.headers = { ...opts.headers, "Authorization": `Bearer ${authToken}` };
  }
  const res = await fetchWithTimeout(abs, opts, MEDIA_HTTP_TIMEOUT_MS, "fetchBinary:request");
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${abs}`);

  console.log(`[fetchBinary] response headers received url=${abs}`);
  const ab = await readWithTimeout(res.arrayBuffer(), MEDIA_HTTP_TIMEOUT_MS, "fetchBinary:body");
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

async function upload(apiKey, fileBuffer, displayName, mimeType) {
  const mid = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const size = mid.length;
  if (!size) throw new Error("Empty file buffer");

  let base = String(displayName || "file").split(/[\\/]/).pop() || "file";
  base = base.split("?")[0].split("#")[0];
  base = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\\r\n]/g, "_");
  if (!base || base === "." || base === "..") base = "file.bin";

  let safeName = base.slice(0, 80);
  let meta = JSON.stringify({ file: { display_name: safeName, mime_type: mimeType } });

  while (meta.length > 520 && safeName.length > 8) {
    safeName = safeName.slice(0, Math.max(8, safeName.length - 12));
    meta = JSON.stringify({ file: { display_name: safeName, mime_type: mimeType } });
  }

  if (meta.length > 600) {
    meta = JSON.stringify({ file: { display_name: "upload.bin", mime_type: mimeType } });
  }

  const startRes = await fetchWithTimeout(
    `${UP}?key=${encodeURIComponent(apiKey)}`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: meta,
    },
    DEFAULT_HTTP_TIMEOUT_MS,
    "upload:start"
  );

  const uploadUrl = startRes.headers.get("x-goog-upload-url") || startRes.headers.get("X-Goog-Upload-Url");
  if (!uploadUrl) {
    const t = await readWithTimeout(startRes.text(), DEFAULT_HTTP_TIMEOUT_MS, "upload:start-read");
    throw new Error(`Upload start ${startRes.status}: ${t.slice(0, 800)}`);
  }

  const upRes = await fetchWithTimeout(
    uploadUrl.trim(),
    {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: mid,
    },
    MEDIA_HTTP_TIMEOUT_MS,
    "upload:bytes"
  );

  const text = await readWithTimeout(upRes.text(), MEDIA_HTTP_TIMEOUT_MS, "upload:bytes-read");

  let json;
  try {
    json = parseJsonSafe(text, "upload-bytes");
  } catch (e) {
    throw new Error(`Upload bytes ${upRes.status}: ${e.message || text.slice(0, 800)}`);
  }

  if (!upRes.ok) {
    const msg = json?.error?.message || text;
    if (upRes.status === 400 && /quicktime|mov|unsupported|codec|hevc|h\.265/i.test(msg)) {
      throw new Error("Video format appears unsupported by Gemini. Convert to MP4 H.264 + AAC, then retry.");
    }
    throw new Error(msg);
  }

  const file = json.file || json;
  if (!file.name || !file.uri) throw new Error(`Bad upload: ${text.slice(0, 400)}`);

  return { name: file.name, uri: file.uri, mimeType };
}

async function uploadVideoWithMovFallback(apiKey, buffer, filename, preferredMime) {
  try {
    return await upload(apiKey, buffer, filename || "audition.mp4", preferredMime);
  } catch (e) {
    const em = String(e?.message || e);
    const fn = String(filename || "");
    const looksMov = /\.mov$/i.test(fn);
    const wasQuicktime = /quicktime/i.test(preferredMime || "");

    if (looksMov && wasQuicktime && /400|codec|unsupported|invalid|failed|quicktime|process/i.test(em)) {
      const altName = fn.replace(/\.mov$/i, ".mp4");
      return await upload(apiKey, buffer, altName || "audition.mp4", "video/mp4");
    }
    throw e;
  }
}

async function convertOfficeToPdfIfNeeded(fileBuffer, filename, mimeType) {
  const name = String(filename || "resume").toLowerCase();
  const isDoc = mimeType === "application/msword" || name.endsWith(".doc");
  const isDocx =
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx");
  if (!isDoc && !isDocx) {
    return { buffer: fileBuffer, mimeType, filename };
  }
  try {
    const pdfBuf = await libreConvertAsync(fileBuffer, ".pdf", undefined);
    const outName = String(filename || "resume").replace(/\.(docx?|DOCX?)$/, ".pdf");
    return { buffer: pdfBuf, mimeType: "application/pdf", filename: outName };
  } catch (e) {
    throw new Error(
      "DOC/DOCX to PDF conversion failed on server. Install LibreOffice in runtime or upload PDF directly. Details: " +
        String(e?.message || e)
    );
  }
}

async function waitActive(apiKey, fileName) {
  const id = String(fileName).replace(/^files\//, "");
  const url = `${FILES}/${encodeURIComponent(id)}?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();

  while (Date.now() - t0 < FILE_ACTIVE_TIMEOUT_MS) {
    const res = await fetchWithTimeout(url, fetchOpts, DEFAULT_HTTP_TIMEOUT_MS, "waitActive:status");
    const text = await readWithTimeout(res.text(), DEFAULT_HTTP_TIMEOUT_MS, "waitActive:status-read");

    let json;
    try {
      json = parseJsonSafe(text, "file-status");
    } catch (e) {
      throw new Error(`File status ${res.status}: ${e.message || text.slice(0, 300)}`);
    }

    if (!res.ok) throw new Error(json?.error?.message || text);
    if (json.state === "ACTIVE") return json;
    if (json.state === "FAILED") throw new Error(`File FAILED: ${text}`);

    await sleep(2000);
  }

  throw new Error("Timeout waiting for file ACTIVE");
}

async function analyzeCasting(properties) {
  const p = properties || {};
  const apiKey = cleanApiKey(p.gemini_api_key) || cleanApiKey(p.api_key) || cleanApiKey(process.env.GEMINI_API_KEY);
  const requestModelList = parseModelList(p.models);
  const envModelList = parseModelList(process.env.MODEL_PRIORITY);
  const modelPriority = Array.from(new Set([...requestModelList, ...envModelList].filter(Boolean)));
  const videoUrl = normalizeUrl(p.video_url);

  if (!apiKey) throw new Error("gemini_api_key required or set GEMINI_API_KEY env var");
  if (!modelPriority.length) {
    throw new Error("No models configured. Provide `models` in request or set MODEL_PRIORITY env var.");
  }
  console.log(`[model-selection] priority=${modelPriority.join(" -> ")}`);
  if (!videoUrl) throw new Error("video_url required");

  const resumeUrl = p.resume_url ? normalizeUrl(p.resume_url) : "";
  const headshotUrl = p.headshot_url ? normalizeUrl(p.headshot_url) : "";

  const vf = await fetchBinary(videoUrl, MEDIA_ACCESS_TOKEN);
  if (vf.size > LIM.v) throw new Error("Video too large");

  const parts = [];
  const videoMime = p.video_mime ? String(p.video_mime).trim() : guessMime(vf.name, "video/mp4");

  const vUp = await uploadVideoWithMovFallback(apiKey, vf.buffer, vf.name || "audition.mp4", videoMime);
  await waitActive(apiKey, vUp.name);
  parts.push({ file_data: { mime_type: vUp.mimeType, file_uri: vUp.uri } });

  let resumeProvided = false;
  let headshotProvided = false;

  if (resumeUrl) {
    const rf = await fetchBinary(resumeUrl, MEDIA_ACCESS_TOKEN);
    if (rf.size > LIM.r) throw new Error("Resume too large");
    const resumeMime = guessMime(rf.name, "application/pdf");
    const normalizedResume = await convertOfficeToPdfIfNeeded(
      rf.buffer,
      rf.name || "resume",
      resumeMime
    );
    const rUp = await upload(
      apiKey,
      normalizedResume.buffer,
      normalizedResume.filename || "resume.pdf",
      normalizedResume.mimeType || "application/pdf"
    );
    await waitActive(apiKey, rUp.name);
    parts.push({ file_data: { mime_type: rUp.mimeType, file_uri: rUp.uri } });
    resumeProvided = true;
  }

  if (headshotUrl) {
    const hf = await fetchBinary(headshotUrl, MEDIA_ACCESS_TOKEN);
    if (hf.size > LIM.h) throw new Error("Headshot too large");
    const hUp = await upload(apiKey, hf.buffer, hf.name || "headshot.jpg", guessMime(hf.name, "image/jpeg"));
    await waitActive(apiKey, hUp.name);
    parts.push({ file_data: { mime_type: hUp.mimeType, file_uri: hUp.uri } });
    headshotProvided = true;
  }

  const drive = p.drive_folder_link ? normalizeUrl(p.drive_folder_link) : "";
  const headshotText = headshotUrl || "";

  const prompt =
    "You are an expert casting evaluator. You MUST watch and reason over the ENTIRE audition video from start to finish (all relevant moments), including audio and visuals—not only the opening seconds. " +
    (resumeProvided
      ? "Use the resume file for relevant experience, training, credits, and skills.\n\n"
      : "No resume file was supplied; base experience assessment only on the text fields and video.\n\n") +
    (headshotProvided
      ? "A headshot image is included as a separate file; use it only for general presentation reference if helpful.\n\n"
      : "No headshot image file was supplied.\n\n") +
    (drive
      ? "Additional materials may exist at this Drive folder link (you cannot browse it; treat as context only): " + drive + "\n\n"
      : "") +
    "VIDEO TYPES (handle all): The submission may be a plain self-introduction, a short skit or monologue, a cold read, an improvisation, a slate, a reel excerpt, or something minimal with little performance. Adapt your criteria accordingly. If the clip contains little or no performative content (e.g., only introduction, reading ID, or a static talking head with no acting task), say so explicitly and score conservatively based on what is actually demonstrated.\n\n" +
    "WHAT TO ANALYZE (be specific and evidence-based):\n" +
    "- Performance and presence: energy, pacing, confidence, clarity, believability, connection to camera or scene partner if applicable.\n" +
    "- Voice and speech: articulation, intelligibility given the recording, tone, emotional coloring when applicable.\n" +
    "- Face and body: facial expressiveness range (subtle vs broad), micro-expressions, emotional authenticity, eye focus and eye contact, posture, gesture appropriateness, and physical suitability hints for the role only when visible.\n" +
    "- Facial-expression evidence: cite specific moments when expressions change (for example neutral -> concern -> relief), and clearly state when visibility, framing, or lighting prevents reliable judgment.\n" +
    "- Fit to THIS role and project: compare against the role description, requirements, characteristics, age and height constraints, location, and casting type.\n\n" +
    "SCORING AND OUTPUT RULES:\n" +
    "- ai_score: integer 0-100 for fit and suitability for THIS specific role, using BOTH video and resume (weight the video heavily when it contains real performance; weight the resume more if the video is non-performative).\n" +
    "- strengths: ONLY positive, specific observations grounded in what you saw, heard, or read. Put facial-expression positives here only when genuinely supported.\n" +
    "- considerations: concerns, risks, gaps, or weaknesses grounded in what you saw, heard, or read. Put facial-expression limitations here when applicable. Do not duplicate the same point in strengths and considerations.\n" +
    "- overall_assessment: concise but detailed summary of fit for the role.\n" +
    "- recommendation: clear next step (for example callback, request more material, or not a fit) with brief rationale.\n\n" +
    "If something cannot be judged from the footage (for example poor mic, face not visible, clip too short), state that limitation in considerations rather than inventing facts.\n\n" +
    "- Location fit: Prefer candidates in or near the role location. If far away, consider whether relocation or remote work is realistic based on the project.\n" +
    "Project Title: " + s(p.PROJECT_TITLE) +
    "\nProject Overview: " + s(p.project_overview) +
    "\nCasting for: " + s(p.casting_for) +
    "\n\nROLE\n" +
    "Role Type: " + s(p.role_type) +
    "\nRole Gender: " + s(p.role_gender) +
    "\nRole Description: " + s(p.role_description) +
    "\nRole Requirements: " + s(p.role_requirements) +
    "\nRole Characteristics: " + roleCharsText(p.role_characteristics) +
    "\nAge Range: " + s(p.age_range) +
    "\nLocation: " + s(p.location) + " (role)" +
    "\nMinimum Height: " + s(p.minimum_height) +
    "\nMaximum Height: " + s(p.maximum_height) +
    "\nMinimum AI Score: " + s(p.minimum_ai_score) +
    "\n\nAPPLICANT\n" +
    "Gender: " + s(p.user_gender) +
    "\nAge: " + s(p.user_age) +
    "\nLocation: " + s(p.user_location) + " (applicant)" +
    "\nHeight: " + s(p.user_height) +
    "\nHeadshot URL (text field): " + (headshotText || "(not provided)") +
    "\nDrive Folder Link: " + (drive || "(not provided)") +
    "\nAbout: " + s(p.about_person) +
    "\nBio: " + s(p.bio) +
    "\n\nReturn ONLY a JSON object with keys: ai_score (integer 0-100), overall_assessment (string), strengths (array of strings), considerations (array of strings), recommendation (string). No markdown, no code fences, no extra text.";
  console.log("prompt");
  console.log(prompt);
  parts.push({ text: prompt });

  const callGenerateContent = async (modelName) => {
    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const genRes = await fetchWithTimeout(
      genUrl,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json" },
      }),
      },
      DEFAULT_HTTP_TIMEOUT_MS,
      `generateContent:${modelName}`
    );

    const genText = await readWithTimeout(genRes.text(), DEFAULT_HTTP_TIMEOUT_MS, `generateContent:${modelName}:read`);
    console.log(`[gemini] model=${modelName} status=${genRes.status}`);
    if (!genRes.ok) {
      console.error(`[gemini] non-ok response body snippet: ${genText.slice(0, 1000)}`);
    }
    let genJson;
    try {
      genJson = parseJsonSafe(genText, "generateContent");
    } catch (e) {
      logError("gemini-parse-response", e, { modelName, status: genRes.status, bodySnippet: genText.slice(0, 1000) });
      throw new Error(`generateContent ${genRes.status}: ${e.message || genText.slice(0, 800)}`);
    }
    return { genRes, genText, genJson, modelName };
  };

  const isRetryableModelError = (resp) => {
    if (!resp || resp.genRes.ok) return false;
    const status = Number(resp.genRes.status);
    const message = String(resp.genJson?.error?.message || resp.genText || "").toLowerCase();
    const isCapacityStatus = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    const isHighDemand =
      message.includes("currently experiencing high demand") ||
      message.includes("spikes in demand") ||
      message.includes("try again later") ||
      message.includes("resource_exhausted") ||
      message.includes("rate limit");
    return isCapacityStatus || isHighDemand;
  };

  const maxAttemptsPerModel = Math.max(1, Number(process.env.MODEL_MAX_ATTEMPTS || 3));
  let genAttempt = null;
  let finalError = null;

  for (let modelIndex = 0; modelIndex < modelPriority.length; modelIndex++) {
    const modelName = modelPriority[modelIndex];
    console.log(`[model-selection] trying model=${modelName} order=${modelIndex + 1}/${modelPriority.length}`);

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      genAttempt = await callGenerateContent(modelName);
      if (genAttempt.genRes.ok) break;

      finalError = new Error(genAttempt.genJson?.error?.message || genAttempt.genText || "Model request failed");
      const shouldRetry = isRetryableModelError(genAttempt) && attempt < maxAttemptsPerModel;
      if (!shouldRetry) break;

      const baseBackoffMs = Math.min(20000, 1200 * Math.pow(2, attempt - 1));
      const jitterMs = Math.floor(Math.random() * 500);
      await sleep(baseBackoffMs + jitterMs);
    }

    if (genAttempt?.genRes?.ok) break;
  }

  if (!genAttempt || !genAttempt.genRes.ok) {
    throw finalError || new Error(genAttempt?.genJson?.error?.message || genAttempt?.genText || "Model request failed");
  }
  if (!genAttempt.genJson.candidates?.length) {
    const br = genAttempt.genJson?.promptFeedback?.blockReason || "";
    throw new Error(`Gemini returned no candidates. ${br}`);
  }

  const cand = genAttempt.genJson.candidates[0];
  const outParts = cand?.content?.parts || [];
  let outText = "";
  for (const part of outParts) outText += part.text || "";
  outText = outText.trim();

  if (!outText) throw new Error(`Empty model text: ${genAttempt.genText.slice(0, 500)}`);

  let parsed;
  try {
    parsed = parseJsonSafe(outText, "model-output");
  } catch (e) {
    throw new Error(`Invalid model JSON: ${e.message || outText.slice(0, 1200)}`);
  }

  const toStrList = (v) => Array.isArray(v) ? v.map((x) => s(x)) : v == null ? [] : [s(v)];
  const rawScore = Number(parsed.ai_score);
  const aiScore = Number.isFinite(rawScore) ? Math.round(Math.max(0, Math.min(100, rawScore))) : 0;

  return {
    overall_assessment: s(parsed.overall_assessment),
    strengths: toStrList(parsed.strengths),
    considerations: toStrList(parsed.considerations),
    recommendation: s(parsed.recommendation),
    ai_score: aiScore,
  };
}

async function sendBubbleCallback(payload, callbackUrl) {
  const requestedCallbackUrl = cleanOptionalUrl(callbackUrl);
  const configuredDefaultCallbackUrl = cleanOptionalUrl(process.env.BUBBLE_CALLBACK_URL);
  const baseUrl = normalizeUrl(requestedCallbackUrl || configuredDefaultCallbackUrl);
  if (!baseUrl) throw new Error("Missing callback URL");
  if (/^https?:\/\/null(?:\/|$)/i.test(baseUrl) || /^https?:\/\/undefined(?:\/|$)/i.test(baseUrl)) {
    throw new Error(`Invalid callback URL after normalization: ${baseUrl}`);
  }
  const callbackCandidates = [];
  const withoutInitialize = baseUrl.replace(/\/initialize(?:\?.*)?$/i, "");
  callbackCandidates.push(baseUrl);
  if (withoutInitialize && withoutInitialize !== baseUrl) callbackCandidates.push(withoutInitialize);

  const maxAttempts = Math.max(1, Number(process.env.CALLBACK_MAX_ATTEMPTS || 4));
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const url of callbackCandidates) {
      try {
        console.log(`[callback] attempt=${attempt}/${maxAttempts} url=${url}`);
        const res = await fetchWithTimeout(
          url,
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          },
          DEFAULT_HTTP_TIMEOUT_MS,
          "bubble-callback"
        );

        if (res.ok) {
          console.log(`[callback] success status=${res.status} url=${url}`);
          return;
        }

        const t = await readWithTimeout(res.text(), DEFAULT_HTTP_TIMEOUT_MS, "bubble-callback-read");
        console.error(`[callback] non-ok status=${res.status} url=${url} body=${t.slice(0, 1000)}`);
        const retryable =
          res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500;
        if (!retryable) {
          throw new Error(`Callback failed ${res.status}: ${t.slice(0, 800)}`);
        }
        lastErr = new Error(`Retryable callback failure ${res.status}: ${t.slice(0, 800)}`);
      } catch (e) {
        logError("bubble-callback-attempt", e, { attempt, url });
        lastErr = e;
      }
    }

    if (attempt < maxAttempts) {
      const backoffMs = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
      await sleep(backoffMs);
    }
  }

  throw new Error(`Bubble callback failed after retries: ${String(lastErr?.message || lastErr)}`);
}

function normPath(p) {
  const s = (p || "").replace(/\/$/, "") || "/";
  return s;
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Bubble often sends almost-valid JSON; parse POST /jobs here + jsonrepair fallback. */
async function parseJobsBody(req, res, next) {
  if (req.method !== "POST" || normPath(req.path) !== "/jobs") return next();
  try {
    const buf = await readBodyBuffer(req);
    const raw = buf.toString("utf8");
    if (!raw.trim()) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(raw);
    } catch (e) {
      try {
        req.body = JSON.parse(jsonrepair(raw));
      } catch (e2) {
        const m = String(e.message || "");
        const posMatch = m.match(/position (\d+)/i);
        const pos = posMatch ? parseInt(posMatch[1], 10) : 0;
        return res.status(400).json({
          error: "Invalid JSON in request body",
          hint:
            "In Bubble: API Connector → Body type JSON, and escape any \" inside text fields. Or send one field as Base64. Server also tried automatic repair.",
          detail: m,
          snippetAroundError: raw.slice(Math.max(0, pos - 60), pos + 60),
        });
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

const app = express();
app.use(cors());
app.use(parseJobsBody);
app.use((req, res, next) => {
  if (req.method === "POST" && normPath(req.path) === "/jobs") return next();
  express.json({ limit: "10mb" })(req, res, next);
});

const jobs = new Map();
const pendingQueue = [];
let activeWorkers = 0;

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2));
const MAX_QUEUE_SIZE = Math.max(1, Number(process.env.MAX_QUEUE_SIZE || 5000));
const JOB_TTL_MS = Math.max(60000, Number(process.env.JOB_TTL_MS || 24 * 60 * 60 * 1000));

function queueDepth() {
  return pendingQueue.length;
}

function totalOutstandingJobs() {
  return queueDepth() + activeWorkers;
}

function pumpQueue() {
  while (activeWorkers < MAX_CONCURRENT_JOBS && pendingQueue.length > 0) {
    const item = pendingQueue.shift();
    if (!item) break;
    const { jobId, payload } = item;
    const existing = jobs.get(jobId);
    if (!existing || existing.status !== "queued") continue;

    activeWorkers += 1;
    console.log(
      `[jobs] start id=${jobId} queue_depth=${queueDepth()} active_workers=${activeWorkers} application_id=${payload?.application_id ?? ""}`
    );
    jobs.set(jobId, { ...existing, status: "processing", startedAt: new Date().toISOString() });

    (async () => {
      try {
        const result = await analyzeCasting(payload);
        const curr = jobs.get(jobId);
        if (curr) {
          jobs.set(jobId, {
            ...curr,
            status: "completed",
            completedAt: new Date().toISOString(),
            result,
          });
        }
        console.log(`[jobs] completed id=${jobId}`);

        await sendBubbleCallback(
          {
            status: "completed",
            application_id: payload.application_id ?? null,
            video_link: payload.video_link ?? payload.video_url ?? null,
            ...result,
          },
          payload.callback_url
        );
        // Clean up immediately after successful callback
        jobs.delete(jobId);
      } catch (err) {
        logError("job-processing", err, {
          jobId,
          application_id: payload?.application_id ?? null,
          video_link: payload?.video_link ?? payload?.video_url ?? null,
        });
        const curr = jobs.get(jobId);
        if (curr) {
          jobs.set(jobId, {
            ...curr,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: String(err?.message || err),
          });
        }

        try {
          await sendBubbleCallback(
            {
              status: "failed",
              application_id: payload.application_id ?? null,
              video_link: payload.video_link ?? payload.video_url ?? null,
              error: String(err?.message || err),
            },
            payload.callback_url
          );
          // Clean up immediately after successful callback
          jobs.delete(jobId);
        } catch (cbErr) {
          logError("bubble-callback-final-failure", cbErr, { jobId, callback_url: payload?.callback_url ?? null });
          // Still clean up even if callback fails to prevent memory leak
          setTimeout(() => jobs.delete(jobId), 5000);
        }
      } finally {
        activeWorkers = Math.max(0, activeWorkers - 1);
        setImmediate(pumpQueue);
      }
    })();
  }
}

// Cleanup every minute as safety net for jobs that fail to reach callback
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const terminal = job.status === "completed" || job.status === "failed";
    if (!terminal) continue;
    const doneAt = new Date(job.completedAt || job.createdAt || now).getTime();
    // Clean up terminal jobs older than 1 minute (main cleanup happens on callback)
    if (now - doneAt > 60 * 1000) jobs.delete(id);
  }
}, 60 * 1000);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "casting-render-service" });
});

app.post("/jobs", (req, res) => {
  if (queueDepth() >= MAX_QUEUE_SIZE) {
    return res.status(429).json({
      error: "Queue is full",
      hint: "Please retry shortly.",
    });
  }

  const jobId = uuidv4();
  const payload = req.body || {};
  payload.video_link = payload.video_link || payload.video_url || "";
  payload.video_url = payload.video_url || payload.video_link || "";

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
  });

  pendingQueue.push({ jobId, payload });
  res.status(200).json({ ok: true, status: "accepted" });
  setImmediate(pumpQueue);
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    queue_depth: queueDepth(),
    active_workers: activeWorkers,
    max_concurrent_jobs: MAX_CONCURRENT_JOBS,
    max_queue_size: MAX_QUEUE_SIZE,
    total_outstanding: totalOutstandingJobs(),
    jobs_tracked: jobs.size,
  });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && /json|parse/i.test(String(err.message))) {
    return res.status(400).json({
      error: "Invalid JSON in request body",
      hint: "Send Content-Type: application/json. Escape inner double-quotes in strings. If a field contains raw newlines, JSON-escape them.",
      detail: err.message,
    });
  }
  next(err);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
