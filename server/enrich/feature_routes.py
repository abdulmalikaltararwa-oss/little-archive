"""HTTP routes for recipe cards, places and ask-your-archive.

Every handler resolves its library from the authenticated caller (`auth.store`), exactly as the rest of the API does, so in
hosted mode an account can only ever reach its own saves. In hosted mode each route also needs the account's one-time unlock
and answers 402 with ``{"detail": ..., "code": "unlock_required", "feature": ...}`` when it is missing. Self-hosted is never gated.
"""
from __future__ import annotations

from typing import ClassVar, Literal

from fastapi import Depends, Query, Request
from pydantic import Field, model_validator

from ..models import StrictModel
from .ask import AskService
from .features import FeatureError, gated, install_feature_errors
from .places import KINDS, PlacesService, to_geojson
from .recipe import RecipeService


# ---------------------------------------------------------------- request bodies

class EditModel(StrictModel):
    """A body the owner edits. Fields the server computes (``READONLY``) are accepted and ignored, so what a GET returned can be
    sent back after changing it; any other unknown field is still refused, so a misspelt name is an error rather than lost data."""
    READONLY: ClassVar[frozenset] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def drop_computed(cls, data):
        return {k: v for k, v in data.items() if k not in cls.READONLY} if isinstance(data, dict) else data


class IngredientIn(EditModel):
    READONLY = frozenset({"unit_text", "scalable", "source", "display", "exact", "approximate", "scaled", "warnings"})
    text: str | None = Field(default=None, max_length=300)
    quantity: float | None = Field(default=None, ge=0, le=100000)
    quantity_max: float | None = Field(default=None, ge=0, le=100000)
    unit: str | None = Field(default=None, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=300)
    group: str | None = Field(default=None, max_length=80)
    optional: bool = False


class StepIn(EditModel):
    READONLY = frozenset({"source", "quote"})
    text: str = Field(min_length=1, max_length=1000)
    timer_seconds: int | None = Field(default=None, ge=1, le=259200)
    no_timer: bool = False                                   # keep a step without a timer even when its text mentions a time
    ingredient_refs: list[int] | None = Field(default=None, max_length=60)
    section: str | None = Field(default=None, max_length=80)


class TimesIn(StrictModel):
    total_seconds: int | None = Field(default=None, ge=0, le=7 * 86400)
    active_seconds: int | None = Field(default=None, ge=0, le=7 * 86400)
    prep_seconds: int | None = Field(default=None, ge=0, le=7 * 86400)
    cook_seconds: int | None = Field(default=None, ge=0, le=7 * 86400)


class RecipeIn(EditModel):
    READONLY = frozenset({"schema", "confidence", "reason", "incomplete", "evidence", "provenance", "dropped"})
    is_recipe: bool = True
    title: str = Field(default="", max_length=200)
    servings: float | None = Field(default=None, gt=0, le=1000)
    servings_text: str | None = Field(default=None, max_length=120)
    time: TimesIn | None = None
    ingredients: list[IngredientIn] = Field(default_factory=list, max_length=100)
    steps: list[StepIn] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=4000)


class RecipeExtractIn(StrictModel):
    method: Literal["auto", "jsonld", "rules", "ai"] = "auto"
    force: bool = False
    fetch_page: bool = False        # read the public page first (needs the operator's page reading to be on)


class CoordinatesIn(EditModel):
    READONLY = frozenset({"source", "detail", "provider", "precision", "display_name", "attribution"})
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PlaceIn(EditModel):
    READONLY = frozenset({"evidence", "origin", "provenance"})
    id: str | None = Field(default=None, max_length=20)
    name: str = Field(min_length=1, max_length=200)
    kind: Literal[tuple(KINDS)] = "other"   # type: ignore[valid-type]
    city: str | None = Field(default=None, max_length=120)
    region: str | None = Field(default=None, max_length=120)
    country: str | None = Field(default=None, max_length=120)
    address: str | None = Field(default=None, max_length=300)
    note: str | None = Field(default=None, max_length=300)
    coordinates: CoordinatesIn | None = None


class PlacesIn(StrictModel):
    places: list[PlaceIn] = Field(default_factory=list, max_length=30)


class PlacesExtractIn(StrictModel):
    method: Literal["auto", "jsonld", "rules", "ai"] = "auto"
    geocode: bool = False           # also look up coordinates; needs the operator's geocoder to be configured
    force: bool = False


class GeocodeIn(StrictModel):
    place_ids: list[str] | None = Field(default=None, max_length=10)


class AskIn(StrictModel):
    question: str = Field(min_length=3, max_length=500)
    limit: int = Field(default=8, ge=1, le=12)
    platform: Literal["", "instagram", "tiktok", "web"] = ""
    collection_id: str = Field(default="", max_length=100)
    tag: str = Field(default="", max_length=80)

    @model_validator(mode="after")
    def need_words(self):
        if not any(ch.isalnum() for ch in self.question):
            raise ValueError("Ask a question in words.")
        return self


def _bbox(value: str | None):
    if value is None:
        return None
    try:
        min_lon, min_lat, max_lon, max_lat = (float(part) for part in value.split(","))
    except ValueError as exc:
        raise FeatureError(422, "bbox must be four numbers: minLon,minLat,maxLon,maxLat.", "invalid_bbox") from exc
    if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180 and -90 <= min_lat <= max_lat <= 90):
        raise FeatureError(422, "bbox must use longitudes from -180 to 180 and latitudes from -90 to 90, south before north.", "invalid_bbox")
    return min_lon, min_lat, max_lon, max_lat


def install_feature_routes(app, *, owner):
    install_feature_errors(app)
    recipes_gate, places_gate, ask_gate = gated(owner, "recipes"), gated(owner, "places"), gated(owner, "ask")

    def recipes(auth):
        return RecipeService(auth.store.enrichment)

    def places(auth):
        return PlacesService(auth.store.enrichment)

    @app.get("/api/features")
    def features(request: Request, auth=Depends(owner)):
        """What this server offers this caller, so a client can show or hide things before trying them."""
        hosted = app.state.config.hosted
        unlocked = bool(app.state.entitlements.is_unlocked(auth.user_id)) if hosted else True
        service = auth.store.enrichment
        ai = service.provider is not None and hasattr(service.provider, "complete_json")
        geocoder = getattr(service, "geocoder", None)
        limits = getattr(app.state, "guided_import_limits", None)
        meters = getattr(app.state, "meters", None)
        locked = hosted and not unlocked and not (meters is not None and meters.features_open_to_free())
        return {
            "mode": app.state.config.mode, "unlocked": unlocked,
            "recipes": {"available": True, "locked": locked, "ai": ai, "methods": ["jsonld", "rules"] + (["ai"] if ai else [])},
            "places": {"available": True, "locked": locked, "ai": ai, "geocoding": {"enabled": bool(geocoder and geocoder.enabled), "attribution": geocoder.attribution if geocoder and geocoder.enabled else None}},
            "ask": {"available": True, "locked": locked, "ai": ai, "answers": ai},
            "guided_import": {"available": True, "locked": False, "platforms": ["instagram", "tiktok"], **(limits.public() if limits else {})},
        }

    # -- recipes
    @app.get("/api/items/{iid}/recipe")
    def get_recipe(iid: str, servings: float | None = Query(default=None, gt=0, le=1000), factor: float | None = Query(default=None, gt=0, le=100), auth=Depends(recipes_gate)):
        if servings is not None and factor is not None:
            raise FeatureError(422, "Choose servings or factor, not both.", "invalid_scale")
        return recipes(auth).view(iid, servings=servings, factor=factor)

    @app.put("/api/items/{iid}/recipe")
    def put_recipe(iid: str, data: RecipeIn, auth=Depends(recipes_gate)):
        return recipes(auth).put(iid, data.model_dump())

    @app.delete("/api/items/{iid}/recipe/edits")
    def discard_recipe_edits(iid: str, auth=Depends(recipes_gate)):
        return recipes(auth).discard_edits(iid)

    @app.post("/api/items/{iid}/recipe/extract")
    def extract_recipe(iid: str, data: RecipeExtractIn | None = None, auth=Depends(recipes_gate)):
        data = data or RecipeExtractIn()
        return recipes(auth).extract(iid, method=data.method, force=data.force, fetch_page=data.fetch_page)

    @app.get("/api/recipes")
    def list_recipes(limit: int = Query(60, ge=1, le=200), offset: int = Query(0, ge=0, le=1000000), include_archived: bool = False, auth=Depends(recipes_gate)):
        return recipes(auth).list(limit=limit, offset=offset, include_archived=include_archived)

    # -- places
    @app.get("/api/items/{iid}/places")
    def get_places(iid: str, auth=Depends(places_gate)):
        return places(auth).view(iid)

    @app.put("/api/items/{iid}/places")
    def put_places(iid: str, data: PlacesIn, auth=Depends(places_gate)):
        return places(auth).put(iid, [p.model_dump() for p in data.places])

    @app.delete("/api/items/{iid}/places/edits")
    def discard_place_edits(iid: str, auth=Depends(places_gate)):
        return places(auth).discard_edits(iid)

    @app.post("/api/items/{iid}/places/extract")
    def extract_places(iid: str, data: PlacesExtractIn | None = None, auth=Depends(places_gate)):
        data = data or PlacesExtractIn()
        return places(auth).extract(iid, method=data.method, geocode=data.geocode, force=data.force)

    @app.post("/api/items/{iid}/places/geocode")
    def geocode_places(iid: str, data: GeocodeIn | None = None, auth=Depends(places_gate)):
        return places(auth).geocode(iid, (data or GeocodeIn()).place_ids)

    @app.get("/api/places")
    def list_places(bbox: str | None = Query(default=None, max_length=120), kind: str = Query(default="", max_length=30), q: str = Query(default="", max_length=200),
                    with_coordinates: bool | None = None, format: Literal["json", "geojson"] = "json", limit: int = Query(200, ge=1, le=1000),
                    offset: int = Query(0, ge=0, le=1000000), include_archived: bool = False, auth=Depends(places_gate)):
        if kind and kind not in KINDS:
            raise FeatureError(422, "Unknown kind of place.", "invalid_kind")
        result = places(auth).list(bbox=_bbox(bbox), kind=kind, q=q, with_coordinates=with_coordinates, limit=limit, offset=offset, include_archived=include_archived)
        return to_geojson(result["places"]) | {"total": result["total"], "limit": limit, "offset": offset} if format == "geojson" else result

    # -- ask
    @app.post("/api/ask")
    def ask(data: AskIn, auth=Depends(ask_gate)):
        return AskService(auth.store.enrichment).ask(data.question, limit=data.limit, platform=data.platform, collection_id=data.collection_id, tag=data.tag)
