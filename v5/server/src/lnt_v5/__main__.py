"""Development entrypoint: `python -m lnt_v5`.

This is what `npm run dev:server` invokes. It exists separately from the image's uvicorn CLI
invocation because dev wants `reload=True` and production wants workers, and no one setting
covers both.

The port is fixed, as it is in the image: client/vite.config.ts proxies /api, /healthz and
/llms.txt to localhost:3000, so a configurable port here would move the server out from under
the dev proxy without saying so.
"""

from __future__ import annotations

import uvicorn

PORT = 3000


def main() -> None:
    uvicorn.run(
        "lnt_v5.app:create_app",
        factory=True,
        host="0.0.0.0",
        port=PORT,
        reload=True,
    )


if __name__ == "__main__":
    main()
