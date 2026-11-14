from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Login(StrictModel):
    password: str = Field(min_length=1, max_length=1024)


class DeviceLogin(StrictModel):
    password: str = Field(min_length=1, max_length=1024)
    name: str = Field(min_length=1, max_length=100)


class AccountDeletion(StrictModel):
    confirm: Literal["DELETE"]


class NewItem(StrictModel):
    url: str = Field(min_length=8, max_length=4096)
    title: str = Field(default="", max_length=500)
    creator: str = Field(default="", max_length=200)
    caption: str = Field(default="", max_length=20000)
    summary: str = Field(default="", max_length=4000)
    notes: str = Field(default="", max_length=20000)
    tags: list[str] = Field(default_factory=list, max_length=50)
    collection_ids: list[str] = Field(default_factory=list, max_length=50)
    preview_url: str | None = Field(default=None, max_length=4096)


class ItemPatch(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(default=None, max_length=4000)
    notes: str | None = Field(default=None, max_length=20000)
    tags: list[str] | None = Field(default=None, max_length=50)
    collection_ids: list[str] | None = Field(default=None, max_length=50)
    favorite: bool | None = None
    status: Literal["inbox", "to_revisit", "done", "archived"] | None = None
    needs_review: bool | None = None

    @field_validator("title", "summary", "notes", "tags", "collection_ids", "favorite", "status", "needs_review", mode="before")
    @classmethod
    def reject_explicit_null(cls, v):
        if v is None:
            raise ValueError("Omit a field to preserve it; null is not an edit value.")
        return v


class CollectionInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    color: str = Field(default="#6F8A72", pattern=r"^#[0-9A-Fa-f]{6}$")


class CollectionPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class LibraryFilters(StrictModel):
    q: str = Field(default="", max_length=500)
    platform: Literal["", "instagram", "tiktok", "web"] = ""
    collection_id: str = Field(default="", max_length=100)
    tag: str = Field(default="", max_length=80)
    status: Literal["", "inbox", "to_revisit", "done", "archived"] = ""
    favorite: bool | None = None
    needs_review: bool | None = None


class BulkAction(StrictModel):
    ids: list[str] | None = Field(default=None, min_length=1, max_length=200)
    filters: LibraryFilters | None = None
    action: Literal["favorite", "unfavorite", "archive", "restore", "tag", "collection"]
    value: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def choose_one_scope(self):
        if (self.ids is None) == (self.filters is None):
            raise ValueError("Choose selected item IDs or a library filter, not both.")
        return self


class TokenInput(StrictModel):
    name: str = Field(min_length=1, max_length=100)


class ImportStart(StrictModel):
    platform: Literal["instagram", "tiktok"]
    source_account: str = Field(min_length=1, max_length=200)
    scope: str = Field(min_length=1, max_length=500)


class SourceCollection(StrictModel):
    source_key: str = Field(min_length=1, max_length=500)
    name: str = Field(min_length=1, max_length=200)


class Observation(StrictModel):
    url: str = Field(min_length=8, max_length=4096)
    title: str = Field(default="", max_length=500)
    creator: str = Field(default="", max_length=200)
    caption: str = Field(default="", max_length=20000)
    thumbnail_alt: str = Field(default="", max_length=20000)
    preview_url: str | None = Field(default=None, max_length=4096)
    content_type: Literal["post", "video", "article", "image", "link"] = "post"
    saved_at: str | None = Field(default=None, max_length=100)
    collections: list[SourceCollection] = Field(default_factory=list, max_length=50)


class ImportBatch(StrictModel):
    batch_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=0, le=1000000)
    items: list[Observation] = Field(min_length=1, max_length=50)


class ImportFinish(StrictModel):
    expected_batches: int = Field(ge=0, le=1000000)
    coverage: Literal["partial", "enumeration_exhausted"] = "partial"
    reason: str = Field(default="", max_length=1000)


class SettingsPatch(StrictModel):
    remote_previews: bool


class AIJobs(StrictModel):
    ids: list[str] | None = Field(default=None, min_length=1, max_length=200)
    filters: LibraryFilters | None = None

    @model_validator(mode="after")
    def choose_one_scope(self):
        if (self.ids is None) == (self.filters is None):
            raise ValueError("Choose selected item IDs or a library filter, not both.")
        return self
