# Custom Tool UI

A tool's input and output render as JSON unless a component claims its part.
Claiming takes two pieces in the chat message component: a **predicate** that
recognises the part, and a renderer entry pairing that predicate with your
component.

## The double-render trap

Every specialised predicate must also join the list of specialised matchers.
That list is the single source of the generic JSON renderer's exclusion — the
generic predicate is derived from it, so a part it does not know about renders
*twice*: once as your card, once as raw JSON beneath it.

Register the predicate there and ordering stops mattering: a part can satisfy
at most one of a specialised card or the generic renderer, whatever order the
renderer list happens to sit in.

## Steps

1. Build the component beside the other tool components in the frontend.
2. Write a predicate. Match a single tool by its exact part type; match a
   family by prefix, the way sub-agent delegation claims every delegate call.
3. Add the predicate to the specialised matchers list.
4. Add a renderer entry pairing the predicate with your component.
5. Handle all four states — `input-streaming`, `input-available`,
   `output-available`, `output-error`. A card that only draws the success state
   is how a failed tool call renders as blank space.

Done when the tool draws your card and no JSON block follows it.

## Typed input and output

A part's `input` and `output` are `unknown` until the tool is listed in the
backend's custom-UI tools type. Listing it there is what buys the narrowing,
and matching the literal part type then needs no cast.

Only core tools with bespoke UI belong there. Plugin- and MCP-contributed tools
are not known at compile time, so their renderers take the generic tool part
type and cast — the trade the extension points force, not an oversight.
