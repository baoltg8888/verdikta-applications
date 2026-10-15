// --- Oracle image-size guards ------------------------------------------------
// Arbiters forward image attachments to every jury model unchanged. Past a
// provider's pixel limit the model call fails with a 400; when every jury model
// rejects the same image, no oracle commits and the submission ends in
// ORACLE_TIMEOUT with the ETH prepay spent (bounty 171, October 2026: a 2560 x 12268
// Medium screenshot was rejected by both claude-sonnet-5 and gpt-5.6-sol).
// Limits below are the ones the providers reported in those errors.
const fs = require('fs').promises;
const sharp = require('sharp');

// Anthropic: "At least one of the image dimensions exceed max allowed size: 8000 pixels"
const MAX_IMAGE_SIDE_PX = 8000;
// OpenAI: "requires 30720 patches after processing, exceeding the limit of 30000"
// (32 x 32 px patches: ceil(w/32) * ceil(h/32))
const IMAGE_PATCH_PX = 32;
const MAX_IMAGE_PATCHES = 30000;

// Formats the arbiter sends to models and sharp can read from the header.
function detectImageFormat(buffer) {
  const b = buffer;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'GIF';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'WebP';
  return null;
}

function imagePatchCount(width, height) {
  return Math.ceil(width / IMAGE_PATCH_PX) * Math.ceil(height / IMAGE_PATCH_PX);
}

/**
 * Reason string if an image of this size would be rejected by the jury models,
 * or null if it fits.
 * @param {string} filename
 * @param {number} width
 * @param {number} height
 * @returns {string|null}
 */
function imageSizeProblem(filename, width, height) {
  const patches = imagePatchCount(width, height);
  const reasons = [];
  if (Math.max(width, height) > MAX_IMAGE_SIDE_PX) reasons.push(`a side is longer than ${MAX_IMAGE_SIDE_PX} px`);
  if (patches > MAX_IMAGE_PATCHES) reasons.push(`it is ${patches} image patches, over the ${MAX_IMAGE_PATCHES} limit`);
  if (!reasons.length) return null;
  return `${filename} is ${width} x ${height} px — too large for the AI models (${reasons.join('; ')}). Every model rejects it, so no oracle can score the submission (ORACLE_TIMEOUT)`;
}

/**
 * Flag image attachments the jury models would reject: oversized, or not decodable
 * despite an image signature. Files that are not PNG/JPEG/GIF/WebP by content are
 * ignored here; other checks cover them.
 * @param {Array<{path:string, originalname:string}>} files
 * @returns {Promise<string[]>} human-readable reasons (empty if all fit)
 */
async function findOversizedImages(files) {
  const problems = [];
  for (const f of files || []) {
    let format = null;
    let fh;
    try {
      fh = await fs.open(f.path, 'r');
      const buf = Buffer.alloc(12);
      await fh.read(buf, 0, 12, 0);
      format = detectImageFormat(buf);
    } catch { /* head unreadable — other checks cover it */ } finally {
      if (fh) await fh.close().catch(() => {});
    }
    if (!format) continue;
    let meta;
    try {
      // Header only; nothing is decoded.
      meta = await sharp(f.path).metadata();
    } catch {
      problems.push(`${f.originalname} looks like a ${format} image but cannot be read — the AI models will reject it`);
      continue;
    }
    if (!meta.width || !meta.height) continue;
    const problem = imageSizeProblem(f.originalname, meta.width, meta.height);
    if (problem) problems.push(problem);
  }
  return problems;
}

const OVERSIZED_IMAGE_FIX = `Split tall screenshots into several images (about 1920 x 1080 each works well) or scale them down. Each image needs every side at most ${MAX_IMAGE_SIDE_PX} px and at most ${MAX_IMAGE_PATCHES} patches of ${IMAGE_PATCH_PX} x ${IMAGE_PATCH_PX} px (roughly 30 megapixels). Splitting also keeps text readable: models shrink very large images before reading them.`;

module.exports = {
  MAX_IMAGE_SIDE_PX,
  IMAGE_PATCH_PX,
  MAX_IMAGE_PATCHES,
  OVERSIZED_IMAGE_FIX,
  detectImageFormat,
  imagePatchCount,
  imageSizeProblem,
  findOversizedImages,
};
