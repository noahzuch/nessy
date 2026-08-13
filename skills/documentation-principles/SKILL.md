---
name: documentation-principles
---

# Documentation Principles

Shared form principles for documentation.

These cover *form* only. Whether the content is correct, complete, and true must be ensured separately.

## Concise

Say it in as few words as the point needs. Cut words that carry no information.

**Violation:** throat-clearing intros, restated headings, multi-sentence points that collapse to one.

> Before: "In order to be able to run the tests, you will first need to make sure that you have installed all of the dependencies."
> 
> After: "Install dependencies before running the tests."

## Reference, don't duplicate

State each fact once. Point to the source instead of restating it — both within a document and across documents. A restatement goes stale when the source changes.

**Violation:** the same fact in two places; a summary of another file that must be kept in sync with it.

> Before: "The cache format is `{ version, session_id, reads: [...] }` (see Architecture § Cache)." — now two copies drift apart.
> 
> After: "The cache format is defined in Architecture § Cache."

## Match existing docs

Align terminology, tone, and conventions to similar documents already in the project. Where there is no precedent, default to business-level formality.

**Violation:** a doc that reads in a different voice or format than its neighbors; slang or academic register where the project is plain and professional.

## Plain and direct

Use the simplest wording that conveys the meaning. No ornate or elaborate phrasing.

**Violation:** jargon for its own sake, long Latinate words, hedging.

> Before: "Utilize the aforementioned methodology to facilitate comprehension."
> 
> After: "Use this method so readers understand."

## Exploit the format

Use the features the target format provides — tables, sections, code blocks, callouts. Use a diagram or image where a visual conveys structure better than prose. Investigate which options you have. Is mermaid installed? Can I include an image? If you think an image would help explaining, your human partner can help you with obtaining e.g. screenshots.

**Violation:** a wall of prose listing items that belong in a table; a flow described in paragraphs where a diagram would be clearer.

## Explain the reason if not directly obvious

Documentation should contain the reason why things are done in a specific way if the reason is not obvious.

This may require more words (goes against 1.), but it is more important to write documentation a reader understands fully.

**Violation:** A not directly obvious instruction or decision, without explanation as to why

> Before: "It is important to replace null values with a different placeholder string."
> 
> After: "It is important to replace null values with a different placeholder string. Otherwise, the later aggregation step could accidentally create ambiguous rows."

## Don't add explicit enumerations

Never use explicit enumeration (1. 2. 3. or a. b. c.) that is contained as characters in the source documentation. Only ever use implicit enumeration (md/adoc list features).
If no implicit enumeration feature can be used (e.g. in section headers), it is better to not include enumeration at all. Use references and anchors if you feel the need to point to a part of a document instead of using numbers.

**Why**: explicit enumeration is bound to get out of sync, harming readability. Only implicit enumerations included in the source format can ensure that it stays correctly up to date.

**Violation:** Adding numbers to sections in a markdown file

> Before: `## 1. Installation`
> 
> After: `## Installation`

**Violation:** Using explicit numbers in listings

> Before (adoc):
>  ```adoc 
>  * 1: Run `uv sync`
>  * 2: Run `pytest tests`
> ```
> After (adoc):  - adoc renders the numbers dynamically
>  ```adoc 
>  . Run `uv sync`
>  . Run `pytest tests`
> ```

## Write good diagrams

When writing diagrams follow  these principles:

* Always add a Legend as a subgraph explaining the different types of components visible in your diagram if not directly clear
* Think about which diagram type you want to draw. Is it a control flow, data flow, C4, Class, Package, Use Case diagram or any other diagram. Try to stay consistent within one diagram type.
* Render diagrams to check if they have the expected result
