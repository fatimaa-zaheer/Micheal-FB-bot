import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

/**
 * Load posts from posts.json
 */
export function loadPosts() {
  const postsFile = path.join(ROOT_DIR, 'posts.json');
  if (!fs.existsSync(postsFile)) {
    console.warn('[scheduler] posts.json not found. No scheduled posts available.');
    return [];
  }
  try {
    const data = fs.readFileSync(postsFile, 'utf-8');
    const posts = JSON.parse(data);
    console.log(`[scheduler] Loaded ${posts.length} posts from posts.json`);
    return posts;
  } catch (err) {
    console.error('[scheduler] Error loading posts.json:', err.message);
    return [];
  }
}

/**
 * Load schedule configuration from schedule.json
 */
export function loadScheduleConfig() {
  const scheduleFile = path.join(ROOT_DIR, 'schedule.json');
  const defaults = {
    scheduling: {
      delayBetweenPostsMs: 21600000, // 6 hours
      postsPerDay: 5,
      enabled: true,
      mode: 'interval',
    },
  };

  if (!fs.existsSync(scheduleFile)) {
    console.warn('[scheduler] schedule.json not found. Using defaults.');
    return defaults;
  }

  try {
    const data = fs.readFileSync(scheduleFile, 'utf-8');
    const config = JSON.parse(data);
    return { ...defaults, ...config };
  } catch (err) {
    console.error('[scheduler] Error loading schedule.json:', err.message);
    return defaults;
  }
}

/**
 * Sleep for a specified number of milliseconds
 */
export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format milliseconds to readable string (e.g., "4 hours 2 minutes")
 */
export function formatDelay(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.length ? parts.join(' ') : '0s';
}

/**
 * Load posting state/history from file
 */
export function loadPostingState() {
  // Check if RESET_POSTS flag is set
  if (process.env.RESET_POSTS === 'true') {
    console.log('🔄 [scheduler] RESET_POSTS is enabled - starting from post 1');
    const freshState = {
      lastPostTime: null,
      postsInLast24h: 0,
      lastResetTime: Date.now(),
      completedPostIds: [],
    };
    return freshState;
  }

  const stateFile = path.join(ROOT_DIR, '.posting-state.json');
  if (!fs.existsSync(stateFile)) {
    return {
      lastPostTime: null,
      postsInLast24h: 0,
      lastResetTime: Date.now(),
      completedPostIds: [],
    };
  }

  try {
    const data = fs.readFileSync(stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      lastPostTime: null,
      postsInLast24h: 0,
      lastResetTime: Date.now(),
      completedPostIds: [],
    };
  }
}

/**
 * Save posting state to file
 */
export function savePostingState(state) {
  const stateFile = path.join(ROOT_DIR, '.posting-state.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[scheduler] Error saving posting state:', err.message);
  }
}

/**
 * Check if we can post based on daily limit
 */
export function canPostAccordingToLimit(config, state) {
  const { postsPerDay } = config.scheduling;

  if (postsPerDay === 0) {
    return true; // No limit
  }

  // Reset counter if 24 hours have passed
  if (Date.now() - state.lastResetTime > 86400000) {
    state.postsInLast24h = 0;
    state.lastResetTime = Date.now();
  }

  return state.postsInLast24h < postsPerDay;
}

/**
 * Update state after posting
 */
export function updateStateAfterPost(state, postId) {
  state.lastPostTime = Date.now();
  state.postsInLast24h += 1;
  if (!state.completedPostIds.includes(postId)) {
    state.completedPostIds.push(postId);
  }
  savePostingState(state);
}

/**
 * Get next post to post (excluding already completed ones)
 */
export function getNextPost(posts, state) {
  const nextPost = posts.find((p) => !state.completedPostIds.includes(p.id));
  return nextPost || null;
}
