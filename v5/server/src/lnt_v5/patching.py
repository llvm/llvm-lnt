"""What a default means on a `PATCH` body, and keeping I8's document from saying otherwise.

Every `PATCH` body is read with `exclude_unset`: a key the request omits leaves the stored value
unchanged, and only a key it sends changes anything. Its models still give each optional key a
default, because that is how pydantic makes a key optional, but the default is never read.

Published, such a default would say the opposite of what the endpoint does: `tracked: true` on
`PATCH /machines/{name}` reads as "omitting `tracked` makes the machine tracked again", and a
generated client may well send it. Every model whose omitted keys mean "unchanged" is therefore
configured with `omit_defaults`, which keeps them out of the document.
"""

from __future__ import annotations

from pydantic.config import JsonDict


def omit_defaults(schema: JsonDict) -> None:
    """Drop every property's `default` from a model's JSON schema. A `json_schema_extra` hook."""
    properties = schema.get("properties")
    if isinstance(properties, dict):
        for property in properties.values():
            if isinstance(property, dict):
                property.pop("default", None)
