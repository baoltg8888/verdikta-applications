/**
 * Regression tests for the oracle image-size guard.
 *
 * Arbiters forward images to every jury model unchanged. Bounty 171 (October 2026):
 * a 2560 x 12268 screenshot was rejected by both claude-sonnet-5 (side > 8000 px) and
 * gpt-5.6-sol (30720 patches > 30000), so no oracle committed and all three
 * submissions ended in ORACLE_TIMEOUT. These cover the upload-time rejection.
 */
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const {
  MAX_IMAGE_SIDE_PX,
  MAX_IMAGE_PATCHES,
  detectImageFormat,
  imagePatchCount,
  imageSizeProblem,
  findOversizedImages,
} = require('../utils/imageLimits');

describe('imagePatchCount / imageSizeProblem', () => {
  it('matches the patch count OpenAI reported for the bounty 171 screenshot', () => {
    expect(imagePatchCount(2560, 12268)).toBe(30720);
  });

  it('flags the bounty 171 screenshot for both limits', () => {
    const reason = imageSizeProblem('medium_article.png', 2560, 12268);
    expect(reason).toMatch(/medium_article\.png is 2560 x 12268 px/);
    expect(reason).toMatch(/longer than 8000 px/);
    expect(reason).toMatch(/30720 image patches/);
  });

  it('flags a side over the limit even when the patch count is small', () => {
    expect(imageSizeProblem('banner.png', 9000, 200)).toMatch(/longer than 8000 px/);
    expect(imageSizeProblem('banner.png', 9000, 200)).not.toMatch(/patches/);
  });

  it('flags a patch count over the limit even when every side fits', () => {
    expect(imagePatchCount(7000, 4500)).toBeGreaterThan(MAX_IMAGE_PATCHES);
    expect(imageSizeProblem('photo.jpg', 7000, 4500)).toMatch(/patches/);
    expect(imageSizeProblem('photo.jpg', 7000, 4500)).not.toMatch(/longer than/);
  });

  it('accepts images that scored fine on mainnet, and images exactly at the limits', () => {
    expect(imageSizeProblem('a.png', 1920, 1008)).toBeNull();
    expect(imageSizeProblem('x_thread.png', 1400, 3198)).toBeNull();
    expect(imageSizeProblem('edge.png', MAX_IMAGE_SIDE_PX, 32)).toBeNull();
    expect(imagePatchCount(4800, 6400)).toBe(MAX_IMAGE_PATCHES);
    expect(imageSizeProblem('edge.png', 4800, 6400)).toBeNull();
  });
});

describe('detectImageFormat (magic bytes)', () => {
  it('detects PNG, JPEG, GIF and WebP signatures', () => {
    expect(detectImageFormat(Buffer.from('89504e470d0a1a0a0000000d', 'hex'))).toBe('PNG');
    expect(detectImageFormat(Buffer.from('ffd8ffe000104a4649460001', 'hex'))).toBe('JPEG');
    expect(detectImageFormat(Buffer.from('474946383961000000000000', 'hex'))).toBe('GIF');
    expect(detectImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('WebP');
  });

  it('ignores non-images and short buffers', () => {
    expect(detectImageFormat(Buffer.from('plain text file here'))).toBeNull();
    expect(detectImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('findOversizedImages (files on disk)', () => {
  let dir;
  const file = async (name, data) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, data);
    return { path: p, originalname: name };
  };
  const png = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();

  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-limits-')); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('rejects a tall page screenshot and passes normal ones', async () => {
    const files = [
      await file('medium_article.png', await png(2560, 12268)),
      await file('x_thread.png', await png(1400, 3198)),
      await file('screenshot.png', await png(1920, 1008)),
    ];
    const problems = await findOversizedImages(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^medium_article\.png is 2560 x 12268 px/);
  });

  it('checks JPEGs by content, whatever the file name', async () => {
    const jpeg = await sharp({ create: { width: 8100, height: 100, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const problems = await findOversizedImages([await file('evidence.txt', jpeg)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/longer than 8000 px/);
  });

  it('reports an image that has a PNG signature but cannot be read', async () => {
    const broken = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not really a png')]);
    const problems = await findOversizedImages([await file('broken.png', broken)]);
    expect(problems).toEqual([expect.stringMatching(/broken\.png looks like a PNG image but cannot be read/)]);
  });

  it('ignores text, PDFs and missing files', async () => {
    const files = [
      await file('notes.md', '# Notes\n'),
      await file('report.pdf', '%PDF-1.7\n'),
      { path: path.join(dir, 'missing.png'), originalname: 'missing.png' },
    ];
    expect(await findOversizedImages(files)).toEqual([]);
  });
});
