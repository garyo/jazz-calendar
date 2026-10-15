"""Data models: the venue and source registries, scraped events, and the published feed.

`EventsFile` is the contract with the site; `jazzcal schema` writes its JSON Schema to
schema/events.schema.json. Change it compatibly, or bump `FEED_VERSION`.
"""

from datetime import date
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

FEED_VERSION = 1

JazzLevel = Literal["dedicated", "regular", "occasional"]
"""How much of a venue's calendar is jazz."""

Listed = Literal["jazz", "adjacent"]
"""Jazz, or jazz-adjacent: soul, funk, latin, blues, swing..."""

Relevance = Listed | Literal["other"]

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class Venue(Model):
    id: str = Field(description="Stable slug, e.g. 'lilypad'")
    name: str
    address: str | None = None
    town: str = Field(description="Municipality, e.g. 'Cambridge'")
    neighborhood: str | None = Field(None, description="e.g. 'Inman Square', 'South End'")
    url: str | None = Field(None, description="Venue home page")
    jazz_level: JazzLevel
    lat: float | None = None
    lng: float | None = None


class Credit(Model):
    """How the site credits a source, with its listings and in the list of sources."""

    name: str = Field(min_length=1, description="For people, e.g. 'MIT Events Calendar'")
    url: str = Field(
        pattern=r"^https://\S+$", description="A public page for people, never an API or feed"
    )
    via: bool = Field(
        False,
        description="A third party to the venue, such as a ticket seller; listings say 'via' it",
    )


class Source(Model):
    """One place we harvest events from, handled by a named adapter."""

    id: str
    adapter: str = Field(description="Adapter name, see jazzcal.adapters")
    url: str
    venue: str | None = Field(None, description="Venue id for single-venue sources")
    credit: Credit | None = Field(None, description="Required for enabled sources")
    enabled: bool = True
    relevance: Relevance | None = Field(
        None, description="Relevance of every event from this source; None means classify each"
    )
    options: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class ScrapedEvent(Model):
    """An event as one adapter found it, before venue resolution, classification and dedup."""

    uid: str = Field(description="Identifier unique within the source")
    title: str
    start: AwareDatetime
    end: AwareDatetime | None = None
    all_day: bool = False
    venue: str | None = Field(None, description="Venue id, when the adapter knows it")
    venue_name: str | None = Field(None, description="Venue as the source gives it")
    url: str | None = Field(None, description="Event page at the source")
    ticket_url: str | None = None
    price: str | None = None
    artists: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list, description="Source's own tags")
    text: str | None = Field(None, description="Description, used only for classification")
    cancelled: bool = False
    relevance: Listed | None = Field(
        None, description="A ruling the source makes per event, e.g. an editor's review"
    )


class Event(Model):
    """A published event."""

    id: str
    title: str
    start: AwareDatetime = Field(description="ISO 8601 with UTC offset, Boston local time")
    end: AwareDatetime | None = None
    all_day: bool = Field(False, description="True when no start time is known")
    venue: str = Field(description="Venue id; see EventsFile.venues")
    url: str = Field(description="Where to read about the event: the venue's or source's page")
    ticket_url: str | None = None
    price: str | None = Field(None, description="Free text, e.g. '$20', 'Free', '$15-25'")
    artists: list[str] = Field(default_factory=list)
    relevance: Listed
    tags: list[str] = Field(default_factory=list, description="e.g. 'jam', 'brunch', 'big band'")
    cancelled: bool = False
    sources: list[str] = Field(description="Ids of the sources that list this event")


class Regular(Model):
    """A standing weekly series with no dated listings: shown apart from the calendar, since a
    standing schedule doesn't promise any particular night."""

    venue: str = Field(description="Venue id")
    title: str
    when: str = Field(description="The schedule as the venue states it, for people")
    days: list[Weekday] = Field(min_length=1, description="The weekdays it runs")
    nth: list[Literal[1, 2, 3, 4, 5, -1]] = Field(
        default_factory=list,
        description="Which of those weekdays in a month it runs (-1 for the last); "
        "empty for every week",
    )
    relevance: Listed
    url: str = Field(description="Where the venue or organizer publishes the schedule")
    checked: date = Field(description="When we last confirmed the schedule there")


class SourceCredit(Credit):
    """A source of the published listings, credited."""

    id: str = Field(description="Source id, as in Event.sources")


class EventsFile(Model):
    """The published feed, served as /data/events.json."""

    version: int = FEED_VERSION
    generated_at: AwareDatetime
    venues: list[Venue]
    events: list[Event] = Field(description="Sorted by start")
    regulars: list[Regular] = Field(default_factory=list)
    sources: list[SourceCredit] = Field(
        default_factory=list,
        description="Every source some event lists, in priority order",
    )


class SourceStatus(Model):
    id: str
    ok: bool
    events: int
    last_success: AwareDatetime | None
    error: str | None = None


class StatusFile(Model):
    """Scraper health, served as /data/status.json."""

    generated_at: AwareDatetime
    sources: list[SourceStatus]
