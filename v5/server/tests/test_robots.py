"""The crawler policy (I10).

Its trailing-slash handling, its 404 for other methods, its indifference to an `Authorization`
header and its absence from I8's document are covered with the other routes outside the REST API,
in `test_spa.py`, `test_errors.py`, `test_auth.py` and `test_docs.py`.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_disallows_every_crawler_everywhere(client: TestClient) -> None:
    # Also covers route ordering: `/robots.txt` reads as a static asset (AR2), so this would 404
    # if the route were registered after the SPA mount at "/".
    response = client.get("/robots.txt")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.text == "User-agent: *\nDisallow: /\n"
