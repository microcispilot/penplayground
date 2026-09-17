# Cost model (per 20-minute solo session, 2026-09 prices)

| Component | Choice | Cost |
|---|---|---|
| Language model | gpt-5.6-luna, effort none, ~40 turns × (1.5k in + 300 out), 50 % cached | $0.021 |
| TTS | Fish Audio s2.1-pro, ~2,600 words ≈ 15 KB | $0.22 (or $0 on s2.1-pro-free until 2026-11-30) |
| STT | AssemblyAI Universal-Streaming $0.15/h (or $0 browser on-device / self-hosted) | $0.05 |
| Onten context | mock today; target < 20 ms, amortised across learners | ~$0 |
| Topic preparation (only on a miss, once per topic) | seed + Tavily + luna | $0.05–0.65 |
| **Total marginal** | | **≈ $0.30 paid voice / ≈ $0.07 with free-tier voice and on-device STT** |

Levers, in order of leverage: prompt-cache prefix discipline (input is >90 % of
LLM spend), sentence brevity on the board, s2.1-pro-free while it lasts, self-hosted
STT on the GPU host, ads on the free tier covering ≈ $0.10–0.30 per session.
