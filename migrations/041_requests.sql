-- Things the operator asked for, kept until they are answered.
--
-- On 23 July he shared a reel with the note "can you download and setup the
-- project or code that lets wifi thru walls work that would be cool". Days
-- later he asked "check progress on that wifi thru walls project I asked you
-- abt" and the agent searched the items folder, the projects directory and the
-- knowledge base and came back with "I can't find a wifi thru walls project in
-- your tracked work". It was there the whole time, as a string in a meta.json
-- beside a video file, because a request arriving attached to something else
-- was only ever stored as a property *of* that thing.
--
-- The distinction this table draws is between an item and an obligation. A
-- capture is "this arrived"; it is finished when it has been read. A request is
-- "you said you'd do this"; it is finished when the thing is done, which may be
-- days later and in a different session, and until then it is owed regardless
-- of how many times the reel it came attached to has been processed.
--
-- Deliberately not a mission. A mission is a plan with steps that Simba
-- executes; most of these are one line of intent that may never become a plan
-- at all, and forcing them into that shape is what stops them being recorded.
CREATE TABLE requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What he actually said, verbatim. Never a summary: "set up the wifi thing"
    -- is findable by someone searching for "wifi", and a tidied version of it
    -- may not be.
    ask          text NOT NULL,

    -- Where it came from: reel:instagram, share, dm, app. The channel matters
    -- for finding it again, because he remembers where he was, not when.
    source       text NOT NULL,

    -- What it arrived attached to, when it arrived attached to something.
    -- ON DELETE SET NULL: the obligation outlives the item. Deleting a reel
    -- does not mean he stopped wanting the thing he asked for while watching it.
    capture_id   uuid REFERENCES captures(id) ON DELETE SET NULL,

    -- open    — owed
    -- done    — the thing was actually done
    -- dropped — explicitly decided against, which is an answer and worth keeping
    --           so the same idea is not re-litigated every time it resurfaces
    status       text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'done', 'dropped')),

    -- How it was answered, or why it was dropped.
    outcome      text,

    -- Where the work happened, so "what came of that" has an answer.
    session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,

    created_at   timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz
);

-- The only query that runs often: what is still owed, oldest first, because an
-- ask that has been open for three weeks is the one worth surfacing.
CREATE INDEX requests_open_idx ON requests (created_at) WHERE status = 'open';

-- "that thing I asked you about" is how he refers to these, so finding one by a
-- half-remembered word out of it is the access pattern that has to work.
CREATE INDEX requests_ask_trgm_idx ON requests USING gin (ask gin_trgm_ops);
