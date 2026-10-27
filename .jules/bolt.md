## 2025-05-18 - Keyframe Array Copy Allocation in Hot Render Loops
**Learning:** `evaluateKeyframes` in `lib/timeline.js` is called for every transform/opacity/volume property on every frame during playback and export. Array cloning (`.slice()`) and `.sort()` inside evaluation methods cause heavy GC pressure in hot animation loops.
**Action:** Since `setKeyframe` maintains keyframe arrays in sorted time order at mutation time, `evaluateKeyframes` can safely read the array directly without cloning or sorting.
