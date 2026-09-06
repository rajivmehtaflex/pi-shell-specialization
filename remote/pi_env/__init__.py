"""Pi adapter package: run Pi noninteractively on benchmark-style shell tasks.

Wave-1 modules (this package):
  config       -- PiConfig: launcher settings read from PI_* environment variables.
  task         -- PiTask: task payload with verifier checks mirroring workers/verify.py.
  sandbox      -- per-rollout workspace split (candidate workspace vs hidden verifier).
  interception -- OpenAI-compatible request/response capture with training/auxiliary
                  classification (InterceptionCore, plus a thin ProxyServer seam).

Later waves add harness.py / runtime.py / verifier.py on top of these.
"""
