# Reference research and attribution

Frosty uses independently written editor code. The repositories below were reviewed for product/architecture ideas; source code, skill files, media, logos, and samples were **not** copied into this implementation. There is no runtime dependency on any of these repositories or on a separate agent-skill package.

## Projects reviewed

- [`fogleman/ln`](https://github.com/fogleman/ln) — MIT, Copyright © 2016 Michael Fogleman. Inspiration: projected vector line art, camera/geometry projection and visible wireframe motifs. Frosty's `lib/motion-design.js` is an independently written JavaScript/SVG implementation, not a port of the Go renderer.
- [`blixvip/MotionClone`](https://github.com/blixvip/MotionClone) — reviewed for the reference → editable project → synchronised comparison workflow. Its README/third-party documentation says there is no project-wide open-source license assigned; therefore Frosty does not copy its code. Its user documentation also identifies HyperFrames as a renderer dependency in that project.
- [`CloudAI-X/threejs-skills`](https://github.com/CloudAI-X/threejs-skills) — MIT, Copyright © 2026 CloudAI-X. Inspiration: practical separation of geometry, materials/themes, animation, interaction and performance. Frosty does not embed Three.js or its skill text as part of this feature.
- [`heygen-com/hyperframes`](https://github.com/heygen-com/hyperframes) — Apache License 2.0. Inspiration: structured, editable media/animation compositions, reusable visual blocks and a plan→validate→preview→render loop. Frosty does not bundle HyperFrames as a renderer here.
- [`zhuyansen/awesome-claude-video-skills`](https://github.com/zhuyansen/awesome-claude-video-skills) — the list itself declares CC0 1.0 Universal, while listed entries have their own separate licenses. Inspiration: tool/workflow taxonomy and the need for repeatable end-to-end validation. Frosty does not ingest or redistribute the collection of listed repos.

## Independently implemented Frosty files

- `lib/reference-template.js`: deterministic source probe, scene-boundary segmentation, transcript timing, pace summary, low-resolution global-motion estimate, analysis schema and editable timeline builder.
- `lib/motion-design.js`: procedural SVG blocks, themes, projected geometry, text escaping and keyframe presets.
- `main.js`, `preload.js`, `lib/ai.js`, `renderer/index.html`, `renderer/app.js`, `renderer/style.css`: IPC bridge, same-generator AI tool, human Motion Studio, reference comparison and Copy workflow.
- `test/reference-template.js`, `test/motion-design.js`, `test/motion-integration-static.js`: regression tests for the feature and integration contracts.

The `awesome-claude-video-skills` list's CC0 notice applies to the list contents stated by its authors, not to third-party projects it names. Check each dependency's license before separately adopting or redistributing its code. This implementation intentionally avoids that ambiguity by using research ideas without importing upstream source code.
