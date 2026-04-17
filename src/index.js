import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

import {
  CAPTCHA_API_KEY,
  FB_EMAIL,
  FB_PASSWORD,
  HEADLESS,
  POST_IMAGE_DIR,
  PAUSE_AFTER_COMPOSE_MS,
  RESET_POSTS,
  SKIP_POST,
  TARGET_GROUP_URLS,
  USER_AGENT,
  USER_DATA_DIR,
  WAIT_FOR_ENTER_BEFORE_CLOSE,
  SESSION_FILE,
  validateConfig,
} from './config.js';

import { resolveCaptchasUntilClear } from './captcha.js';
import { randomStepDelay, randomMouseMove, sleep, typeIntoFacebookComposer } from './humanize.js';
import { pickImageByPostId } from './media.js';
import {
  loadPosts,
  loadScheduleConfig,
  loadPostingState,
  canPostAccordingToLimit,
  getNextPost,
  updateStateAfterPost,
  formatDelay,
} from './scheduler.js';
import {
  loadSessionFromDisk,
  collectFacebookCookies,
  waitUntilLoggedIn,
  ensureFreshLogin,
  isLoginOrCheckpointUrl,
  hasUserCookie,
  waitForEnter,
} from './session.js';

const timers = new Map();

function startTimer(label) {
  timers.set(label, Date.now());
  console.log(`⏱️  [timer] ${label} started`);
}

function endTimer(label) {
  const startedAt = timers.get(label);
  if (!startedAt) return;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ [timer] ${label} - took ${elapsed}s`);
  timers.delete(label);
}

async function saveSessionCookies(pageOrCookies) {
  const cookies = Array.isArray(pageOrCookies)
    ? pageOrCookies
    : pageOrCookies?.cookies
      ? await pageOrCookies.cookies()
      : [];
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf8');
  } catch (err) {
    console.warn('[session] Failed to save cookies:', err.message);
  }
}

async function restoreSessionCookies(page) {
  const cookies = await loadSessionFromDisk();
  if (cookies?.length) {
    try {
      await page.setCookie(...cookies);
    } catch (err) {
      console.warn('[session] Cookie restore warning:', err.message);
    }
  }
}

async function isLoggedInState(page) {
  try {
    const cookies = await page.cookies();
    return hasUserCookie(cookies) && !isLoginOrCheckpointUrl(page.url());
  } catch {
    return false;
  }
}

async function isPageAlive(page) {
  try {
    return !!page && !page.isClosed() && typeof page.url === 'function';
  } catch {
    return false;
  }
}

async function autoLoginIfNeeded(page) {
  const transientError = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('execution context was destroyed') ||
      msg.includes('navigating frame was detached') ||
      msg.includes('cannot find context') ||
      msg.includes('target closed')
    );
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('[login] ====== AUTO-LOGIN ATTEMPT ======');
      if (await isLoggedInState(page)) {
        console.log('[login] Already logged in.');
        return true;
      }

      const tryClick = async (selectors) => {
        for (const selector of selectors) {
          const handle = await page.$(selector);
          if (handle) {
            try {
              await handle.click();
              return true;
            } catch {
              /* continue */
            }
          }
        }
        return false;
      };

      console.log('[login] ====== STEP 1: Looking for Email Field ======');
      const emailField = await page.$('input[name="email"], input[type="email"], #email');
      if (emailField) {
        await emailField.click({ clickCount: 3 });
        await page.keyboard.type(FB_EMAIL, { delay: 60 });
        console.log('[login] Email field filled');
        await tryClick(['button[name="login"]', 'button[type="submit"]', 'div[role="button"][aria-label*="Continue" i]']);
      } else {
        console.log('[login] Email field not immediately visible');
      }

      console.log('[login] ====== STEP 2: Looking for Continue Button ======');
      await tryClick([
        'button[name="login"]',
        'button[type="submit"]',
        'div[role="button"][aria-label*="Continue" i]',
        'div[role="button"][aria-label*="Log In" i]',
      ]);

      console.log('[login] ====== STEP 3: Looking for Password Field ======');
      const passwordField = await page.$('input[name="pass"], input[type="password"], #pass');
      if (passwordField) {
        await passwordField.click({ clickCount: 3 });
        await page.keyboard.type(FB_PASSWORD, { delay: 60 });
        console.log('[login] Password field filled');
        await tryClick(['button[name="login"]', 'button[type="submit"]', 'div[role="button"][aria-label*="Log In" i]']);
      } else {
        console.log('[login] No password field found - already logged in or unexpected state');
      }

      await sleep(2000);
      console.log('[login] ====== AUTO-LOGIN COMPLETE ======');
      return isLoggedInState(page);
    } catch (err) {
      if (!transientError(err) || attempt === 3) throw err;
      console.warn(`[login] Transient page reset during login (attempt ${attempt}/3). Retrying...`);
      await sleep(1500);
    }
  }

  return false;
}

async function openGroupComposer(page) {
  await randomMouseMove(page);

  const openers = [
    'div[role="button"][aria-label*="Create a post" i]',
    'div[role="button"][aria-label*="Write something" i]',
    'div[role="button"][aria-label*="Create post" i]',
    'a[aria-label*="Create a post" i]',
    'button[aria-label*="Create a post" i]',
  ];

  // Composer can be slow to render in some groups, so retry a few times.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const alreadyOpen = await page.$('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]');
    if (alreadyOpen) return;

    for (const selector of openers) {
      const el = await page.$(selector);
      if (el) {
        try {
          await el.click();
          await sleep(900);
        } catch {
          /* continue */
        }
      }
    }

    // Fallback: click by visible text/aria across button-like elements.
    await page.evaluate(() => {
      const candidates = ['create a post', 'write something', "what\'s on your mind", 'create post'];
      for (const el of document.querySelectorAll('[role="button"], button, a')) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = (el.textContent || '').toLowerCase();
        if (candidates.some((w) => aria.includes(w) || text.includes(w))) {
          (el).click();
          break;
        }
      }
    });

    try {
      await page.waitForFunction(
        () => !!document.querySelector('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]'),
        { timeout: 5000 }
      );
      return;
    } catch {
      console.log(`[composer] Attempt ${attempt}/3 failed, retrying...`);
      await sleep(1200);
    }
  }

  throw new Error('Could not open the Facebook composer.');
}

async function getDialogComposerText(page) {
  return page.evaluate(() => {
    const box = document.querySelector('div[role="dialog"] div[role="textbox"][contenteditable="true"]');
    if (!box) return '';
    return (box.innerText || box.textContent || '').trim();
  });
}

async function ensureComposerHasText(page, text, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  const snippet = (text || '').slice(0, 20).toLowerCase();

  let current = (await getDialogComposerText(page)).toLowerCase();
  if (snippet && current.includes(snippet)) return true;

  console.log(`${tag} ⚠️ Composer text missing before submit. Retrying type once...`);
  await typeIntoFacebookComposer(page, text);
  await sleep(1000);

  current = (await getDialogComposerText(page)).toLowerCase();
  const ok = snippet && current.includes(snippet);
  if (!ok) {
    throw new Error('Composer text not detected after retry; aborting submit to avoid image-only post.');
  }
  return true;
}

async function hasComposerImage(page) {
  return page.evaluate(() => {
    // Prefer the active composer dialog (the one that has the textbox).
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find((d) => d.querySelector('[role="textbox"]')) || dialogs[0] || null;
    if (!dialog) return false;

    // Most reliable: a file input inside composer currently has selected files.
    for (const input of dialog.querySelectorAll('input[type="file"]')) {
      if (input.files && input.files.length > 0) return true;
    }

    // Fallback 1: image nodes/URLs in composer.
    for (const img of dialog.querySelectorAll('img')) {
      const src = img.src || '';
      if (src.startsWith('blob:') || src.startsWith('data:') || src.includes('scontent')) return true;
    }

    // Fallback 2: background-image previews.
    for (const el of dialog.querySelectorAll('[style]')) {
      const bg = el.style.backgroundImage || '';
      if (bg.includes('blob:') || bg.includes('scontent')) return true;
    }

    // Fallback 3: attachment action controls Facebook shows when media exists.
    return !!(
      dialog.querySelector('[aria-label*="Remove photo" i]') ||
      dialog.querySelector('[aria-label*="Edit photo" i]') ||
      dialog.querySelector('[aria-label*="Edit all" i]') ||
      dialog.querySelector('[data-testid*="photo"]')
    );
  });
}

async function ensureComposerHasImage(page, imagePath, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  // Give Facebook a moment to render the attachment state before re-uploading.
  await sleep(1500);
  if (await hasComposerImage(page)) return true;

  console.log(`${tag} ⚠️ Image missing before submit. Retrying image upload once...`);
  const retryOk = await uploadImageToComposer(page, imagePath, groupIndex);
  await sleep(1200);
  if (!retryOk || !(await hasComposerImage(page))) {
    throw new Error('Image not detected in composer after retry; aborting submit to avoid text-only post.');
  }
  return true;
}

async function waitForImageUploadToSettle(page, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  try {
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return true;
      const busy =
        !!dialog.querySelector('[aria-label*="Uploading" i]') ||
        !!dialog.querySelector('[aria-label*="Processing" i]') ||
        !!dialog.querySelector('[role="progressbar"]');
      return !busy;
    }, { timeout: 12000 });
    console.log(`${tag} ✅ Image upload settled`);
  } catch {
    console.log(`${tag} ⚠️ Image settling timeout; proceeding`);
  }
}

async function uploadImageToComposer(groupPage, imagePath, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  console.log(`${tag} 🖼️  Starting image upload: ${imagePath}`);

  if (!fs.existsSync(imagePath)) {
    console.log(`${tag} ❌ File does not exist: ${imagePath}`);
    return false;
  }

  const inputsBefore = await groupPage.$$eval('input[type="file"]', (els) => els.length);
  console.log(`${tag} File inputs before photo click: ${inputsBefore}`);

  // Preferred path: handle native file chooser directly.
  const chooserSelectors = [
    '[role="dialog"] [role="button"][aria-label*="photo" i]',
    '[role="dialog"] [role="button"][aria-label*="image" i]',
    '[role="dialog"] button[aria-label*="photo" i]',
    '[role="dialog"] button[aria-label*="image" i]',
    'div[role="button"][aria-label*="photo" i]',
    'div[role="button"][aria-label*="image" i]',
  ];

  for (const selector of chooserSelectors) {
    const btn = await groupPage.$(selector);
    if (!btn) continue;
    try {
      const chooserPromise = groupPage.waitForFileChooser({ timeout: 2500 });
      await btn.click();
      const chooser = await chooserPromise;
      await chooser.accept([imagePath]);
      console.log(`${tag} ✅ File chooser accepted via selector: ${selector}`);

      await groupPage.screenshot({ path: './debug_after_upload.png', fullPage: false });
      
      // Just verify the browser accepted the file (file input has value)
      // Visual preview rendering is unpredictable; file acceptance is the key signal
      const fileAccepted = await groupPage.evaluate(() => {
        return document.querySelectorAll('input[type="file"]').length > 0;
      });
      
      if (fileAccepted) {
        console.log(`${tag} ✅ File chooser accepted and file input exists`);
        await sleep(2000); // Brief pause for preview to start rendering
        return true;
      } else {
        console.log(`${tag} ❌ File input disappeared after chooser accept`);
        return false;
      }
    } catch {
      // Not the right button for file chooser; continue trying others.
    }
  }

  let photoClicked = false;

  try {
    const clicked = await groupPage.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      for (const btn of dialog.querySelectorAll('[role="button"], button')) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('photo') || aria.includes('image')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      photoClicked = true;
      console.log(`${tag} ✅ Method 1: dialog photo button clicked`);
    }
  } catch {
    /* continue */
  }

  if (!photoClicked) {
    try {
      const found = await groupPage.evaluate(() => {
        const textbox = document.querySelector('[role="textbox"]');
        if (!textbox) return false;
        let container = textbox;
        for (let i = 0; i < 10; i++) {
          container = container.parentElement;
          if (!container) break;
          for (const btn of container.querySelectorAll('[role="button"], button')) {
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();
            if (aria.includes('photo') || aria.includes('image') || title.includes('photo') || title.includes('image')) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });
      if (found) {
        photoClicked = true;
        console.log(`${tag} ✅ Method 2: textbox-parent button clicked`);
      }
    } catch {
      /* continue */
    }
  }

  if (!photoClicked) {
    try {
      const clicked = await groupPage.evaluate(() => {
        for (const elem of document.querySelectorAll('[role="button"], button, [role="menuitem"]')) {
          const aria = (elem.getAttribute('aria-label') || '').toLowerCase();
          const title = (elem.getAttribute('title') || '').toLowerCase();
          if (aria.includes('photo') || aria.includes('image') || title.includes('photo') || title.includes('image')) {
            elem.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        photoClicked = true;
        console.log(`${tag} ✅ Method 3: global sweep clicked`);
      }
    } catch {
      /* continue */
    }
  }

  if (!photoClicked) {
    console.log(`${tag} ❌ Could not find photo button — skipping image`);
    return false;
  }

  try {
    await groupPage.waitForFunction(
      (countBefore) => document.querySelectorAll('input[type="file"]').length > countBefore,
      { timeout: 8000 },
      inputsBefore
    );
    console.log(`${tag} ✅ New file input appeared`);
  } catch (e) {
    console.log(`${tag} ⚠️  No new file input appeared: ${e.message}`);
  }

  await sleep(500);

  const allInputs = await groupPage.$$('input[type="file"]');
  const inputsAfter = allInputs.length;
  console.log(`${tag} File inputs after photo click: ${inputsAfter}`);

  if (!inputsAfter) {
    console.log(`${tag} ❌ No file inputs available after clicking photo`);
    return false;
  }

  const composerInput = allInputs[inputsAfter - 1];

  try {
    await composerInput.uploadFile(imagePath);
    console.log(`${tag} ✅ uploadFile() on composer input (index ${inputsAfter})`);

    await groupPage.screenshot({ path: './debug_after_upload.png', fullPage: false });

    // Don't wait for visual preview; instead, verify the file was accepted by the input
    // Facebook's preview rendering timing is unreliable; file acceptance is the signal
    const hasFileValue = await groupPage.evaluate(() => {
      for (const input of document.querySelectorAll('input[type="file"]')) {
        if (input.files && input.files.length > 0) {
          return true;
        }
      }
      return false;
    });

    if (hasFileValue) {
      console.log(`${tag} ✅ Image file accepted by input element`);
      await sleep(2000); // Brief pause for preview to start rendering
      return true;
    } else {
      console.log(`${tag} ❌ File input has no value after uploadFile()`);
      return false;
    }
  } catch (err) {
    console.log(`${tag} ❌ Upload failed: ${err.message}`);
    return false;
  }
}

async function submitPost(page, { requireImage = false, imagePath = null, groupIndex = null } = {}) {
  const tag = groupIndex ? `[group ${groupIndex}]` : '[submit]';

  const waitForSubmitSignal = async () => {
    try {
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);
      const uiPromise = page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const bodyText = (document.body?.innerText || '').toLowerCase();

        // Success signal: composer dialog closed after submit.
        const dialogClosed = !dialog;

        // Additional success text Facebook often shows.
        const hasPostedSignal =
          bodyText.includes('your post is pending') ||
          bodyText.includes('post submitted') ||
          bodyText.includes('post sent for review') ||
          bodyText.includes('your post is live');
        return dialogClosed || hasPostedSignal;
      }, { timeout: 12000 }).catch(() => null);

      await Promise.race([navPromise, uiPromise]);

      // Re-check once in current context after transitions.
      const confirmed = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const bodyText = (document.body?.innerText || '').toLowerCase();
        return (
          !dialog ||
          bodyText.includes('your post is pending') ||
          bodyText.includes('post submitted') ||
          bodyText.includes('post sent for review') ||
          bodyText.includes('your post is live')
        );
      });
      return !!confirmed;
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      // Facebook often destroys execution context right after successful submit.
      if (msg.includes('execution context was destroyed') || msg.includes('navigating frame was detached')) {
        return true;
      }
      return false;
    }
  };

  const clickPrimaryPostButton = async () => {
    const exact = await page.$('[role="dialog"] [role="button"][aria-label="Post"]');
    if (exact) {
      try {
        await exact.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
        await exact.click({ delay: 60 });
        return true;
      } catch {
        // Fall through to robust DOM fallback.
      }
    }

    return page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;

      const all = Array.from(dialog.querySelectorAll('[role="button"], button'));
      const candidates = [];
      for (const el of all) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const isPost = txt === 'post' || aria === 'post' || aria.includes('post');
        if (!isPost) continue;

        const disabled = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
        if (disabled) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;

        candidates.push({ el, bottom: rect.bottom, right: rect.right });
      }

      if (!candidates.length) return false;

      // Primary action is typically the bottom-right Post button in the dialog.
      candidates.sort((a, b) => (b.bottom - a.bottom) || (b.right - a.right));
      const target = candidates[0].el;

      // Prefer native click for React handlers; event-dispatch can be ignored.
      try {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.click();
        return true;
      } catch {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
    });
  };

  const ensureImageAtSubmit = async () => {
    if (!requireImage) return true;
    if (await hasComposerImage(page)) return true;
    await sleep(1200);
    if (await hasComposerImage(page)) return true;
    if (imagePath && groupIndex) {
      console.log(`${tag} ⚠️ Image missing at submit; re-attaching once...`);
      const uploaded = await uploadImageToComposer(page, imagePath, groupIndex);
      if (uploaded) {
        await waitForImageUploadToSettle(page, groupIndex);
      }
      return hasComposerImage(page);
    }
    return false;
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const imageReady = await ensureImageAtSubmit();
    if (!imageReady) {
      throw new Error('Image missing at submit time; aborting to avoid text-only post.');
    }

    const clicked = await clickPrimaryPostButton();
    if (!clicked) {
      throw new Error('Could not find enabled primary Post button in composer dialog.');
    }

    const ok = await waitForSubmitSignal();
    if (ok) return true;

    if (attempt < 2) {
      console.log(`${tag} ⚠️ Submit not confirmed on first click, retrying...`);
      await sleep(1200);
    }
  }

  throw new Error('Post click did not produce a submit confirmation (dialog still open).');
}

async function navigateToGroupWithRetry(page, url, groupIndex) {
  const label = `[group ${groupIndex}]`;
  const attempts = [
    { waitUntil: 'networkidle2', timeout: 120000 },
    { waitUntil: 'domcontentloaded', timeout: 120000 },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      await page.goto(url, attempts[i]);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`${label} Navigation attempt ${i + 1}/${attempts.length} failed: ${msg}`);
      if (i === attempts.length - 1) throw err;
      await sleep(2000);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  validateConfig();

  const scheduleConfig = loadScheduleConfig();
  const schedulingEnabled = scheduleConfig.scheduling.enabled;
  const posts = schedulingEnabled ? loadPosts() : [];
  const state = schedulingEnabled ? loadPostingState() : null;

  let postsToPost = [];
  if (schedulingEnabled && posts.length > 0) {
    const nextPost = getNextPost(posts, state);
    if (nextPost) {
      postsToPost = [nextPost];
      console.log(`[scheduler] Found next post: Post #${nextPost.id}`);
    } else {
      console.log('[scheduler] All posts have been completed.');
      return;
    }
  } else if (!schedulingEnabled && process.env.POST_TEXT?.trim()) {
    postsToPost = [{ id: 1, text: process.env.POST_TEXT }];
  } else {
    throw new Error('No posts to post: enable scheduling or set POST_TEXT.');
  }

  const launchOptions = {
    headless: HEADLESS || 'new',  // Force headless mode; use 'new' for better container support
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',        // important for Railway
      '--disable-extensions',
      '--disable-web-resources'
    ],
    defaultViewport: { width: 1280, height: 900 },
  };

  // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (Railway)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[puppeteer] Using Chromium at: ${launchOptions.executablePath}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await restoreSessionCookies(page);
  await resolveCaptchasUntilClear(page, CAPTCHA_API_KEY);

  console.log('[session] Attempting auto-login...');
  await autoLoginIfNeeded(page);
  await sleep(2000);

  if (!(await isLoggedInState(page))) {
    const ok = await waitUntilLoggedIn(page);
    if (!ok) {
      await browser.close();
      throw new Error('Login was not completed.');
    }
  }

  const cookies = await collectFacebookCookies(page);
  await saveSessionCookies(cookies);
  console.log('[session] Cookies saved to session.json');
  console.log(`[multi-group] Posting to ${TARGET_GROUP_URLS.length} group(s).`);

  const postStartTime = Date.now();

  for (const post of postsToPost) {
    try {
      if (schedulingEnabled && state && !canPostAccordingToLimit(scheduleConfig, state)) {
        console.log('[scheduler] Daily limit reached. Stopping.');
        await browser.close();
        return;
      }

      console.log(`\n${'='.repeat(70)}`);
      console.log(`📝 POST #${post.id} START TIME: ${new Date().toLocaleTimeString()}`);
      console.log(`${'='.repeat(70)}`);

      for (let i = 0; i < TARGET_GROUP_URLS.length; i++) {
        const groupUrl = TARGET_GROUP_URLS[i];
        const isLast = i === TARGET_GROUP_URLS.length - 1;
        const groupTimerLabel = `Group ${i + 1} total time`;

        console.log(`\n[group ${i + 1}/${TARGET_GROUP_URLS.length}] ${groupUrl}`);
        startTimer(groupTimerLabel);

        let groupPage = null;

        try {
          groupPage = await browser.newPage();
          await groupPage.setUserAgent(USER_AGENT);

          const stored = await loadSessionFromDisk();
          if (stored?.length) {
            try { await groupPage.setCookie(...stored); }
            catch (err) { console.warn('[session] Cookie apply warning:', err.message); }
          }

          console.log(`[group ${i + 1}] Opening in new tab...`);
          startTimer(`Group ${i + 1} navigation`);
          await navigateToGroupWithRetry(groupPage, groupUrl, i + 1);
          endTimer(`Group ${i + 1} navigation`);

          await autoLoginIfNeeded(groupPage);
          await saveSessionCookies(groupPage);

          startTimer(`Group ${i + 1} captcha`);
          await resolveCaptchasUntilClear(groupPage, CAPTCHA_API_KEY);
          endTimer(`Group ${i + 1} captcha`);

          if (isLoginOrCheckpointUrl(groupPage.url()) || !(await isLoggedInState(groupPage))) {
            await ensureFreshLogin(groupPage, 'Session expired.');
            await sleep(1000);
            await autoLoginIfNeeded(groupPage);
            await saveSessionCookies(groupPage);
            await navigateToGroupWithRetry(groupPage, groupUrl, i + 1);
            await autoLoginIfNeeded(groupPage);
            await saveSessionCookies(groupPage);
            await resolveCaptchasUntilClear(groupPage, CAPTCHA_API_KEY);
          }

          console.log(`[group ${i + 1}] Opening composer...`);
          startTimer(`Group ${i + 1} composer open`);
          await openGroupComposer(groupPage);
          endTimer(`Group ${i + 1} composer open`);

          await randomMouseMove(groupPage);
          await sleep(randomStepDelay());

          let selectedImagePath = null;
          if (POST_IMAGE_DIR) {
            try {
              selectedImagePath = await pickImageByPostId(POST_IMAGE_DIR, post.id);
              if (!selectedImagePath) {
                console.log(`[group ${i + 1}] No image available for this post`);
              }
            } catch (imgErr) {
              console.warn(`[group ${i + 1}] ⚠️ Image pick error: ${imgErr.message}`);
            }
          }

          if (!(await isPageAlive(groupPage))) {
            throw new Error('Page closed or crashed before typing could start');
          }

          console.log(`[group ${i + 1}] Typing message...`);
          startTimer(`Group ${i + 1} typing`);
          await typeIntoFacebookComposer(groupPage, post.text);
          endTimer(`Group ${i + 1} typing`);

          await ensureComposerHasText(groupPage, post.text, i + 1);

          if (selectedImagePath) {
            startTimer(`Group ${i + 1} image upload`);
            const uploaded = await uploadImageToComposer(groupPage, selectedImagePath, i + 1);
            endTimer(`Group ${i + 1} image upload`);
            if (!uploaded) {
              console.warn(`[group ${i + 1}] ⚠️ Initial image upload did not confirm preview`);
              await ensureComposerHasImage(groupPage, selectedImagePath, i + 1);
            } else {
              console.log(`[group ${i + 1}] ✅ Image upload accepted; proceeding without early re-upload`);
            }
            await sleep(2000);
          }

          if (selectedImagePath) {
            await sleep(1000);
          } else {
            await sleep(PAUSE_AFTER_COMPOSE_MS);
          }

          if (SKIP_POST) {
            console.log(`[group ${i + 1}] ✅ Draft ready. SKIP_POST=true — not clicking Post.`);
          } else {
            if (selectedImagePath) {
              await waitForImageUploadToSettle(groupPage, i + 1);
            }
            console.log(`[group ${i + 1}] Submitting post...`);
            startTimer(`Group ${i + 1} submit`);
            await submitPost(groupPage, {
              requireImage: !!selectedImagePath,
              imagePath: selectedImagePath,
              groupIndex: i + 1,
            });
            endTimer(`Group ${i + 1} submit`);
            console.log(`[group ${i + 1}] ✅ Post submitted!`);
            await sleep(PAUSE_AFTER_COMPOSE_MS);
          }

          if (!isLast) {
            console.log(`[group ${i + 1}] Waiting 30s before next group...`);
            await sleep(30000);
          }
        } catch (err) {
          console.error(`❌ [group ${i + 1}] Error: ${err.message}`);
          if (String(err.message || '').toLowerCase().includes('connection closed')) {
            throw err;
          }
          console.log(`[group ${i + 1}] Skipping and continuing...`);

          if (!isLast) {
            console.log(`[group ${i + 1}] Waiting 15s to recover...`);
            await sleep(15000);
          }
        } finally {
          if (groupPage) {
            try { await groupPage.close(); console.log(`[group ${i + 1}] Tab closed.`); }
            catch { /* already closed */ }
          }
          endTimer(groupTimerLabel);
        }
      }

      if (schedulingEnabled && state) {
        updateStateAfterPost(state, post.id);
        console.log(`[scheduler] Post #${post.id} done. Posted today: ${state.postsInLast24h}`);
        const nextPost = getNextPost(posts, state);
        if (nextPost) {
          console.log(`[scheduler] Next post in ${formatDelay(scheduleConfig.scheduling.delayBetweenPostsMs)} (Post #${nextPost.id})`);
        }
        const totalMin = ((Date.now() - postStartTime) / 1000 / 60).toFixed(2);
        console.log(`\n${'='.repeat(70)}`);
        console.log(`✅ POST #${post.id} COMPLETED - Total time: ${totalMin} minutes`);
        console.log(`${'='.repeat(70)}\n`);
      }
    } catch (postErr) {
      console.error(`[posting] Error on post #${post.id}: ${postErr.message}`);
      if (String(postErr.message || '').toLowerCase().includes('connection closed')) {
        console.error('[posting] Browser disconnected. Stopping run so this post can be retried next launch.');
        throw postErr;
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('🎉 ALL POSTS COMPLETED');
  console.log('='.repeat(70));

  if (WAIT_FOR_ENTER_BEFORE_CLOSE) await waitForEnter();
  else await sleep(15000);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
