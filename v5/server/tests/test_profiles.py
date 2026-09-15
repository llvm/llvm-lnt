"""The profile endpoints (endpoints.md, Profiles).

Driven over the real application and a real database. What is interesting here is mostly what the
endpoints refuse to do: the listing never touches the blob (D5, D12), the metadata and function
list never decompress, and a blob the server stored and cannot read is a 500 rather than anything
the caller could have avoided (R4).

The two blobs below were produced by v4's own writer, the same recipe `test_profile_format.py`
documents:

    from lnt.testing.profile.profilev1impl import ProfileV1
    from lnt.testing.profile.profilev2impl import ProfileV2
    base64.b64encode(ProfileV2.upgrade(ProfileV1(data)).serialize())

Embedded rather than generated, so what is served is the format as it exists in the wild rather
than as this tree imagines it, and so these tests need nothing from v4 at run time.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from conftest import code_of, run_payload
from lnt_v5 import profile_format
from lnt_v5.routes.profiles import PROFILES_PATH, RUN_PROFILES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.tables import SuiteTables

# Written from this ProfileV1 data:
#
#     {'counters': {'cycles': 1234567, 'branch-misses': 890},
#      'disassembly-format': 'llvm-objdump',
#      'functions': {
#        'main':  {'counters': {'cycles': 50.0, 'branch-misses': 60.0},
#                  'data': [[{'cycles': 30.0, 'branch-misses': 40.0}, 0x1000, 'push rbp'],
#                           [{'cycles': 20.0, 'branch-misses': 20.0}, 0x1004, 'ret']]},
#        'hot':   {'counters': {'cycles': 100.0, 'branch-misses': 5.0},
#                  'data': [[{'cycles': 100.0, 'branch-misses': 5.0}, 0x2000, 'ret']]},
#        'tie_b': {'counters': {'cycles': 10.0}, 'data': [[{'cycles': 10.0}, 0x3000, 'ret']]},
#        'tie_a': {'counters': {'cycles': 10.0}, 'data': [[{'cycles': 10.0}, 0x4000, 'ret']]},
#        'cold':  {'counters': {'cycles': 1.0}, 'data': []}}}
#
# The counters are chosen so the two orderings differ: `main` is the hottest by the sum endpoints.md
# sorts on, while `hot` is the hottest by `cycles` alone. `tie_a` and `tie_b` have the same sum and
# are named in the order that is not the blob's, so the tiebreaker has something to do.
PROFILE = (
    "AgANDRYjCCs7ZjKYASe/ATMK8gFebGx2bS1vYmpkdW1wCgJicmFuY2gtbWlzc2VzCmN5Y2xlcwoCAPoGAYetS0Ja"
    "aDkxQVkmU1kAw8mjAAAEQHQEAEIioQBAAEAAIAAxADASKNNonSj0uWKCY0LXrPi7kinChIAGHk0YQlpoOTFBWSZT"
    "WSrTZpEAAAPVQCQAQABAAEAAQAAgADDABppmhGlSmF3JFOFCQKtNmkRCWmg5MUFZJlNZV4rsNAAAAUAAVAAgACGY"
    "GYRN4XckU4UJBXiuw0BCWmg5MUFZJlNZQuNswQAABNGAABBAABJAXgAgADEAMCAMIgDCINNrxdyRThQkELjbMEAF"
    "Y29sZAoAAAAAAQGAgID8A2hvdAoBAAABAgCAgICFBAGAgKCWBG1haW4KAgoCAwIAgIDAkwQBgICgkgR0aWVfYQoB"
    "HgUGAQGAgICJBHRpZV9iCgEjCAgBAYCAgIkE"
)

# The same writer on three function names that a path segment would otherwise mangle, each with one
# `ret` in it. `{'counters': {'cycles': 42}, 'disassembly-format': 'llvm-objdump', 'functions':
# {SLASHED: ..., PUNCTUATED: ..., MANGLED: ...}}`, with counters 3.0, 2.0 and 1.0 respectively.
EXOTIC = (
    "AgANDQgVAxgwSC93JZwBLArIAdkBbGx2bS1vYmpkdW1wCgFjeWNsZXMKAQAqQlpoOTFBWSZTWWO3UngAAAPAQMwA"
    "UAAABCAAMMAI0emoKEXeyeLuSKcKEgx26k8AQlpoOTFBWSZTWZfzmEUAAAIVQEAAQABAAEAAIAAhmmgzTRrni7ki"
    "nChIS/nMIoBCWmg5MUFZJlNZxYVDjQAAAEAAUAAgACEAgoMXckU4UJDFhUONQlpoOTFBWSZTWRiRaOcAAAFBgAAQ"
    "AgAUACAAIZpoM00XPF3JFOFCQGJFo5wDTWF0cml4PGRvdWJsZSwgMz46Om9wZXJhdG9yKihNYXRyaXg8ZG91Ymxl"
    "LCAzPiBjb25zdCYpICYKAQAAAAEAgICAgARfWk5TdDNfXzE2dmVjdG9ySWlOU185YWxsb2NhdG9ySWlFRUU5cHVz"
    "aF9iYWNrRVJLaQoBBQICAQCAgID8A3N0ZDo6b3BlcmF0b3IvKHN0ZDo6ZmlsZXN5c3RlbTo6cGF0aCBjb25zdCYs"
    "IHN0ZDo6ZmlsZXN5c3RlbTo6cGF0aCBjb25zdCYpCgEKBAQBAICAgIIE"
)

# A demangled `operator/` overload, which is the whole reason the function name segment spans the
# rest of the path (R1): v4's importer runs `objdump -C`, so what is stored is demangled.
SLASHED = "std::operator/(std::filesystem::path const&, std::filesystem::path const&)"
# Spaces, angle brackets, an ampersand and a comma -- every character a query string would have had
# to escape, in a segment that does not.
PUNCTUATED = "Matrix<double, 3>::operator*(Matrix<double, 3> const&) &"
# What the same symbol looks like when the producer did not demangle.
MANGLED = "_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi"

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}

RUNS = RUNS_PATH.format(testsuite="nts")
PROFILES = PROFILES_PATH.format(testsuite="nts")


def run_profiles(run: str) -> str:
    return RUN_PROFILES_PATH.format(testsuite="nts", uuid=run)


def truncated(encoded: str) -> str:
    """A blob that passes submission's version check and then runs out (D12).

    Submission looks at the first byte and nothing else, so a prefix of a real profile is stored
    exactly as a corrupted one would be: the section table survives and describes sections that are
    no longer there. Fifty bytes is past the table and into the first section it describes.
    """
    return base64.b64encode(base64.b64decode(encoded)[:50]).decode()


def undecompressible(encoded: str) -> str:
    """A blob whose index is intact and whose four bz2 streams are not.

    The technique `test_profile_format.py` uses, and the reason it works on a stored blob: the
    stream headers are overwritten in place, so every offset and size in the section table still
    describes the section it did before. Anything that reads only the index is unaffected; anything
    that decompresses fails. The count is asserted because this is a blind search over a constant --
    finding a different number of streams would mean the constant, not the reader, had changed.
    """
    data = bytearray(base64.b64decode(encoded))
    found = 0
    for at in range(len(data) - 3):
        if bytes(data[at : at + 4]) == b"BZh9":
            data[at : at + 4] = b"nope"
            found += 1
    assert found == 4, found
    return base64.b64encode(bytes(data)).decode()


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., str]:
    """Submit a run whose test entries are `(test name, encoded profile or None)`, and name it."""

    def post(*tests: tuple[str, str | None]) -> str:
        entries = [{"name": name, "profile": profile} for name, profile in tests]
        response = api_client.post(RUNS, json=run_payload(tests=entries), headers=submitter)
        assert response.status_code == 201, response.text
        return str(response.json()["uuid"])

    return post


@pytest.fixture
def stored(api_client: TestClient, submit: Callable[..., str]) -> Callable[..., str]:
    """Store one profile and hand back its UUID.

    Through the listing, which is the bridge endpoints.md gives a client that knows a run and a
    test name and needs a UUID -- and which has tests of its own below.
    """

    def store(encoded: str = PROFILE) -> str:
        run = submit(("bench", encoded))
        listed = api_client.get(run_profiles(run))
        assert listed.status_code == 200, listed.text
        return str(listed.json()["items"][0]["uuid"])

    return store


class TestRunListing:
    """`GET /runs/{uuid}/profiles`: the bridge from run+test coordinates to UUIDs."""

    def test_carries_the_test_name_and_the_uuid_in_r2s_unpaginated_envelope(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        body = api_client.get(run_profiles(run)).json()

        assert list(body) == ["items"]
        assert [item["test"] for item in body["items"]] == ["bench"]
        assert len(body["items"]) == 1

    def test_is_ordered_by_test_name(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # endpoints.md: the client renders this straight into a dropdown, and the list is bounded
        # by the tests of one run, so unlike `GET /runs/{uuid}/samples` it can afford the sort.
        run = submit(("zeta", PROFILE), ("alpha", PROFILE), ("middle", PROFILE))

        items = api_client.get(run_profiles(run)).json()["items"]

        assert [item["test"] for item in items] == ["alpha", "middle", "zeta"]

    def test_lists_only_the_tests_that_carry_a_profile(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("with", PROFILE), ("without", None))

        items = api_client.get(run_profiles(run)).json()["items"]

        assert [item["test"] for item in items] == ["with"]

    def test_a_run_with_no_profiles_is_an_empty_envelope(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # An ordinary answer rather than a 404: the run exists and carries nothing.
        run = submit(("bench", None))

        response = api_client.get(run_profiles(run))

        assert response.status_code == 200
        assert response.json() == {"items": []}

    def test_serves_only_this_runs_profiles(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        mine = submit(("mine", PROFILE))
        submit(("theirs", PROFILE))

        items = api_client.get(run_profiles(mine)).json()["items"]

        assert [item["test"] for item in items] == ["mine"]

    def test_the_uuid_addresses_the_profile_data_endpoints(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]

        assert api_client.get(f"{PROFILES}/{uuid}").json()["run_uuid"] == run

    def test_accepts_the_run_uuid_in_either_case(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        upper = api_client.get(run_profiles(run.upper()))

        assert upper.json() == api_client.get(run_profiles(run)).json()

    def test_is_404_for_a_run_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(run_profiles(str(uuid4())))

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.get(f"{SUITES_PATH}/nope/runs/{uuid4()}/profiles")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestMetadata:
    """`GET /profiles/{uuid}`: what the profile is of, and its top-level counters."""

    @pytest.fixture
    def metadata(self, stored: Callable[..., str]) -> str:
        return stored()

    def test_carries_exactly_the_keys_endpoints_md_gives_it(
        self, api_client: TestClient, metadata: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{metadata}")

        assert response.status_code == 200
        assert set(response.json()) == {
            "uuid",
            "test",
            "run_uuid",
            "counters",
            "disassembly_format",
        }

    def test_names_the_profile_the_test_and_the_run(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))
        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]

        body = api_client.get(f"{PROFILES}/{uuid}").json()

        assert (body["uuid"], body["test"], body["run_uuid"]) == (uuid, "bench", run)

    def test_the_top_level_counters_are_raw_integers(
        self, api_client: TestClient, metadata: str
    ) -> None:
        # endpoints.md: the top-level counters are the one integer-valued counters in a profile,
        # and they are raw totals rather than a share of anything.
        counters = api_client.get(f"{PROFILES}/{metadata}").json()["counters"]

        assert counters == {"cycles": 1234567, "branch-misses": 890}
        assert all(isinstance(value, int) for value in counters.values())

    def test_reports_the_disassembly_format(self, api_client: TestClient, metadata: str) -> None:
        body = api_client.get(f"{PROFILES}/{metadata}").json()

        assert body["disassembly_format"] == "llvm-objdump"

    def test_accepts_the_profile_uuid_in_either_case(
        self, api_client: TestClient, metadata: str
    ) -> None:
        upper = api_client.get(f"{PROFILES}/{metadata.upper()}")

        assert upper.json() == api_client.get(f"{PROFILES}/{metadata}").json()


class TestFunctionList:
    """`GET /profiles/{uuid}/functions`: every function, hottest first."""

    @pytest.fixture
    def listed(self, api_client: TestClient, stored: Callable[..., str]) -> dict[str, Any]:
        body: dict[str, Any] = api_client.get(f"{PROFILES}/{stored()}/functions").json()
        return body

    def test_is_r2s_unpaginated_envelope_over_name_counters_and_length(
        self, listed: dict[str, Any]
    ) -> None:
        assert list(listed) == ["items"]
        assert all(set(item) == {"name", "counters", "length"} for item in listed["items"])

    def test_covers_every_function_the_profile_holds(self, listed: dict[str, Any]) -> None:
        assert {item["name"] for item in listed["items"]} == {
            "main",
            "hot",
            "tie_a",
            "tie_b",
            "cold",
        }

    def test_is_sorted_by_the_sum_of_a_functions_counters_descending(
        self, listed: dict[str, Any]
    ) -> None:
        # endpoints.md: hottest first, where "hottest" is the sum across counters -- a default
        # ordering rather than a physical quantity. `hot` has the larger `cycles` of the two and
        # still comes second, which is exactly the case the client's own counter dropdown re-sorts.
        assert [item["name"] for item in listed["items"]][:2] == ["main", "hot"]

    def test_breaks_a_tie_by_name_ascending(self, listed: dict[str, Any]) -> None:
        # Two functions with the same sum, so without the tiebreaker the order would be whatever
        # the blob happened to list. endpoints.md makes it total.
        names = [item["name"] for item in listed["items"]]

        assert names == ["main", "hot", "tie_a", "tie_b", "cold"]

    def test_the_counters_are_the_raw_aggregate_rather_than_a_percentage(
        self, listed: dict[str, Any]
    ) -> None:
        # The v4 proof of concept called these percentages; endpoints.md is emphatic that every
        # counter the API serves is raw and the client computes shares from it.
        functions = {item["name"]: item["counters"] for item in listed["items"]}

        assert functions["hot"] == {"cycles": 100.0, "branch-misses": 5.0}

    def test_a_function_carries_only_the_counters_it_was_measured_with(
        self, listed: dict[str, Any]
    ) -> None:
        functions = {item["name"]: item["counters"] for item in listed["items"]}

        assert functions["tie_a"] == {"cycles": 10.0}

    def test_the_length_is_the_instruction_count(self, listed: dict[str, Any]) -> None:
        lengths = {item["name"]: item["length"] for item in listed["items"]}

        assert lengths == {"main": 2, "hot": 1, "tie_a": 1, "tie_b": 1, "cold": 0}


class TestFunctionDisassembly:
    """`GET /profiles/{uuid}/functions/{fn_name}`: the one endpoint that decompresses."""

    @pytest.fixture
    def disassembly(self, api_client: TestClient, stored: Callable[..., str]) -> dict[str, Any]:
        body: dict[str, Any] = api_client.get(f"{PROFILES}/{stored()}/functions/main").json()
        return body

    def test_carries_exactly_the_keys_endpoints_md_gives_it(
        self, disassembly: dict[str, Any]
    ) -> None:
        assert set(disassembly) == {"name", "counters", "disassembly_format", "instructions"}

    def test_repeats_the_functions_aggregate_counters(self, disassembly: dict[str, Any]) -> None:
        assert disassembly["name"] == "main"
        assert disassembly["counters"] == {"cycles": 50.0, "branch-misses": 60.0}
        assert disassembly["disassembly_format"] == "llvm-objdump"

    def test_serves_every_instruction_with_its_address_counters_and_text(
        self, disassembly: dict[str, Any]
    ) -> None:
        # Addresses are stored as deltas from the previous one, so a wrong reading of the second
        # would be a wrong address rather than a failure. Counters are raw, as everywhere else.
        assert disassembly["instructions"] == [
            {
                "address": 0x1000,
                "counters": {"cycles": 30.0, "branch-misses": 40.0},
                "text": "push rbp",
            },
            {
                "address": 0x1004,
                "counters": {"cycles": 20.0, "branch-misses": 20.0},
                "text": "ret",
            },
        ]

    def test_an_address_is_an_integer(self, disassembly: dict[str, Any]) -> None:
        assert all(isinstance(one["address"], int) for one in disassembly["instructions"])

    def test_a_function_with_no_instructions_is_an_empty_list(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        response = api_client.get(f"{PROFILES}/{stored()}/functions/cold")

        assert response.status_code == 200
        assert response.json()["instructions"] == []

    def test_is_404_for_a_function_the_profile_does_not_hold(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        # Not an `internal_error`: the blob is perfectly readable and simply has no such function.
        response = api_client.get(f"{PROFILES}/{stored()}/functions/nosuchfunction")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_parses_the_blob_once_per_request(
        self, api_client: TestClient, stored: Callable[..., str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A parse is not cached between requests, deliberately, so the one thing worth pinning is
        # that a single request does not pay for it twice -- the aggregate counters this response
        # repeats come from the profile already parsed for the disassembly.
        uuid = stored()
        parses = 0
        real = profile_format.read_profile

        def counting(data: bytes) -> profile_format.Profile:
            nonlocal parses
            parses += 1
            return real(data)

        monkeypatch.setattr(profile_format, "read_profile", counting)

        assert api_client.get(f"{PROFILES}/{uuid}/functions/main").status_code == 200
        assert parses == 1


class TestFunctionNames:
    """R1: the function name spans the rest of the path, which is what makes these reachable."""

    @pytest.fixture
    def exotic(self, stored: Callable[..., str]) -> str:
        return stored(EXOTIC)

    @pytest.mark.parametrize("name", [SLASHED, PUNCTUATED, MANGLED])
    def test_the_function_list_serves_the_name_verbatim(
        self, api_client: TestClient, exotic: str, name: str
    ) -> None:
        items = api_client.get(f"{PROFILES}/{exotic}/functions").json()["items"]

        assert name in {item["name"] for item in items}

    def test_a_name_containing_a_slash_is_addressable(
        self, api_client: TestClient, exotic: str
    ) -> None:
        # The premise R1 used to rest on -- that only a test name can contain `/` -- is false: v4's
        # importer demangles, so an `operator/` overload arrives with one in it. It works here and
        # not for a test name because this segment is the last of its path.
        response = api_client.get(f"{PROFILES}/{exotic}/functions/{SLASHED}")

        assert response.status_code == 200
        assert response.json()["name"] == SLASHED
        assert response.json()["counters"] == {"cycles": 3.0}

    def test_a_percent_encoded_slash_addresses_the_same_function(
        self, api_client: TestClient, exotic: str
    ) -> None:
        # A server decodes `%2F` back to a separator before routing, so the two spellings are the
        # same request by the time anything matches -- and the greedy segment captures either.
        encoded = SLASHED.replace("/", "%2F").replace(":", "%3A")

        response = api_client.get(f"{PROFILES}/{exotic}/functions/{encoded}")

        assert response.status_code == 200
        assert response.json()["name"] == SLASHED

    def test_a_name_containing_spaces_and_punctuation_is_addressable(
        self, api_client: TestClient, exotic: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{exotic}/functions/{PUNCTUATED}")

        assert response.status_code == 200
        assert response.json()["name"] == PUNCTUATED

    def test_a_mangled_name_is_addressable(self, api_client: TestClient, exotic: str) -> None:
        # A producer that does not demangle is equally supported; nothing here interprets the name.
        response = api_client.get(f"{PROFILES}/{exotic}/functions/{MANGLED}")

        assert response.status_code == 200
        assert response.json()["counters"] == {"cycles": 1.0}

    def test_a_trailing_slash_reaches_the_function_list(
        self, api_client: TestClient, exotic: str
    ) -> None:
        # R1's redirect runs before routing, so `/functions/` is the list rather than a request for
        # a function with an empty name. The greedy segment would otherwise have matched it.
        response = api_client.get(f"{PROFILES}/{exotic}/functions/", follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"].endswith(f"{PROFILES}/{exotic}/functions")


# The three endpoints that address a profile by its UUID, as the suffix each adds to it. Several
# things below hold for all three and are asserted once over this list rather than once per class.
PROFILE_DATA = ["", "/functions", "/functions/main"]


class TestAddressingSomethingThatIsNotThere:
    """The 404s the three profile data endpoints share (R1, endpoints.md).

    One class over all three rather than a copy in each, so that a fourth data endpoint inherits
    the coverage instead of quietly going without it.
    """

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_a_profile_uuid_no_profile_has_is_404(
        self, api_client: TestClient, suite: SuiteTables, suffix: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{uuid4()}{suffix}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_a_suite_that_does_not_exist_is_404(self, api_client: TestClient, suffix: str) -> None:
        # Before the profile is looked for at all: R1 scopes every one of these to a suite.
        response = api_client.get(f"{SUITES_PATH}/nope/profiles/{uuid4()}{suffix}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestUnreadableBlob:
    """R4's `internal_error`, which it names this exact case for.

    A blob is stored without being parsed (D12), so the server can hold one it cannot read. The
    caller did nothing wrong, hence a 500 rather than a 400 or a 404.
    """

    @pytest.fixture
    def corrupt(self, stored: Callable[..., str]) -> str:
        return stored(truncated(PROFILE))

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_is_a_500_carrying_the_r4_envelope(
        self, api_client: TestClient, corrupt: str, suffix: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{corrupt}{suffix}")

        assert response.status_code == 500
        assert code_of(response) == "internal_error"

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_says_what_is_wrong_with_the_blob(
        self, api_client: TestClient, corrupt: str, suffix: str
    ) -> None:
        # Not the generic handler's "the server failed to answer this request": whoever reads this
        # has to be able to tell a corrupt profile from a fault, and which section failed.
        message = api_client.get(f"{PROFILES}/{corrupt}{suffix}").json()["error"]["message"]

        assert corrupt in message
        assert "CounterNamePool" in message
        assert "past the end" in message

    def test_a_blob_that_only_fails_to_decompress_still_serves_its_index(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        # The laziness the format exists for, seen from the outside: the index is readable and the
        # compressed sections are not, so two of the three endpoints answer and one cannot.
        uuid = stored(undecompressible(PROFILE))

        assert api_client.get(f"{PROFILES}/{uuid}").status_code == 200
        assert api_client.get(f"{PROFILES}/{uuid}/functions").status_code == 200

        response = api_client.get(f"{PROFILES}/{uuid}/functions/main")

        assert response.status_code == 500
        assert "LineCounters" in response.json()["error"]["message"]

    def test_the_metadata_and_function_list_never_decompress(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        # The same blob, asserted positively: everything those two responses carry comes out of the
        # uncompressed index, so breaking every bz2 stream in the profile changes neither of them.
        intact = stored(PROFILE)
        broken = stored(undecompressible(PROFILE))

        def contents(uuid: str) -> tuple[Any, Any]:
            metadata = api_client.get(f"{PROFILES}/{uuid}").json()
            functions = api_client.get(f"{PROFILES}/{uuid}/functions").json()
            # Without the three keys that name the profile rather than describe it.
            return (metadata["counters"], metadata["disassembly_format"]), functions

        assert contents(broken) == contents(intact)


class TestTheBlobStaysOutOfTheListing:
    """D5 and D12: `data` is excluded from the default result set and loaded only when needed.

    Core selects the columns it is asked for, so the rule is a property of each query rather than
    of the table, and the check has to be one too. Renaming the column out from under the server is
    the strongest form of it available: a query that names `data` cannot run at all afterwards, and
    one that does not is untouched.
    """

    @pytest.fixture
    def without_the_column(self, db_engine: Engine) -> Callable[[], None]:
        def rename() -> None:
            with db_engine.begin() as connection:
                connection.execute(text("ALTER TABLE nts.profile RENAME COLUMN data TO hidden"))

        return rename

    def test_the_listing_does_not_touch_the_blob(
        self,
        api_client: TestClient,
        submit: Callable[..., str],
        without_the_column: Callable[[], None],
    ) -> None:
        run = submit(("bench", PROFILE))
        without_the_column()

        response = api_client.get(run_profiles(run))

        assert response.status_code == 200
        assert [item["test"] for item in response.json()["items"]] == ["bench"]

    def test_the_data_endpoints_do(
        self,
        api_client: TestClient,
        stored: Callable[..., str],
        without_the_column: Callable[[], None],
    ) -> None:
        # The other half of the check: without this the test above would pass just as well against
        # an endpoint that had stopped working. A column the server expects and cannot find is D2's
        # stale reader, so the 409 is the schema-changed answer rather than a fault.
        uuid = stored()
        without_the_column()

        response = api_client.get(f"{PROFILES}/{uuid}")

        assert response.status_code == 409
        assert code_of(response) == "conflict"


class TestAuthorization:
    """R5: `read` on all four, which every valid key grants and anonymous access satisfies."""

    @pytest.fixture
    def paths(self, api_client: TestClient, submit: Callable[..., str]) -> list[str]:
        run = submit(("bench", PROFILE))
        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]
        return [
            run_profiles(run),
            f"{PROFILES}/{uuid}",
            f"{PROFILES}/{uuid}/functions",
            f"{PROFILES}/{uuid}/functions/main",
        ]

    def test_needs_no_credential(self, api_client: TestClient, paths: list[str]) -> None:
        assert [api_client.get(path).status_code for path in paths] == [200] * 4

    def test_a_read_key_is_enough(
        self,
        api_client: TestClient,
        paths: list[str],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(make_key(Scope.READ))

        assert [api_client.get(path, headers=headers).status_code for path in paths] == [200] * 4

    def test_an_unknown_token_is_401_even_though_read_allows_anonymous_access(
        self, api_client: TestClient, paths: list[str], bearer: Callable[[str], dict[str, str]]
    ) -> None:
        # R5: a bad credential is never silently downgraded to anonymous access.
        headers = bearer("0" * 64)

        assert [api_client.get(path, headers=headers).status_code for path in paths] == [401] * 4
