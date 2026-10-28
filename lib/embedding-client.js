'use strict';

/**
 * Prevent an offline optional embedding service from adding one long timeout per
 * scene while indexing. A failed request opens a short circuit; after the cooldown
 * expires the next request probes the service again. Lexical indexing/search remain
 * controlled by the caller and are never disabled by this wrapper.
 */
function withCooldownEmbedding(embed, { cooldownMs = 30000, now = Date.now } = {}) {
  if (typeof embed !== 'function') throw new TypeError('embed must be a function');
  const cooldown = Math.max(0, Math.min(10 * 60 * 1000, Number(cooldownMs) || 0));
  let disabledUntil = 0;
  let lastError = '';
  let consecutiveFailures = 0;

  const wrapped = async (...args) => {
    const time = now();
    if (time < disabledUntil) {
      throw new Error(`Embedding service temporarily suppressed for ${Math.ceil((disabledUntil - time) / 1000)}s after a prior failure${lastError ? `: ${lastError}` : ''}`);
    }
    try {
      const vector = await embed(...args);
      if (!Array.isArray(vector) || vector.length < 8 || !vector.every(Number.isFinite)) {
        throw new Error('Embedding provider returned an invalid vector');
      }
      disabledUntil = 0;
      lastError = '';
      consecutiveFailures = 0;
      return vector;
    } catch (error) {
      consecutiveFailures += 1;
      lastError = String(error?.message || error || 'unknown error').slice(0, 180);
      disabledUntil = now() + cooldown;
      throw error;
    }
  };

  wrapped.status = () => ({
    coolingDown: now() < disabledUntil,
    retryAfterMs: Math.max(0, disabledUntil - now()),
    consecutiveFailures,
    lastError
  });
  wrapped.reset = () => { disabledUntil = 0; lastError = ''; consecutiveFailures = 0; };
  return wrapped;
}

module.exports = { withCooldownEmbedding };
