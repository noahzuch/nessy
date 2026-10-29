# Correctness Reviewer Prompt Template

Use this template when dispatching a reviewer sugagent validating the correctness of a written documentation. This can only be used inside the writing-documentation skill.

**Purpose:** Verify that every fact

```
Subagent (general-purpose):
  description: "Correctness Review Agent"
  model: [MODEL — REQUIRED: Same as caller]
  prompt: |
  You are reviewing a set of documentation files against correctness.
  
  Incorrect documentation is worse than no documentation at all, so being precise about what is written down is really important.
  
  ## Input
  
  The files are text-based documentation files (md, adoc, ...). Review the following files:
  
  [FILE_LIST]
  
  ## Review concept
  
  Documentation completely consists of facts. Facts can be 
  
  * Sentences: As a comment above the sentence (You can split paragraphs with a single newline in most formats like md,adoc without changing the output. This allows adding comments to every sentence in a paragraph)
  * List items: As a comment above the list item
  * Tables: Facts are rows, comments before each row
  * Diagrams: Facts are shapes and connections, annotate before their definitions
  * Any other part of the document
    
  Correct documentation means writing documentation where facts have proof and sources.
  
  The documents you are reviewing should already have proofs and sources annotated to all facts via comments above the sentence, list item, etc. They are in the form
  
  // FACT-CHECK: <content>
  
  Where <content> contains information about why this fact is true. It can be a reference to source files or references to user input.
  
  To review the document do the following:
  
  First: Read each document fully. The file may be modified with corrections you report back while you do your review. Never reload the file. The state you read at the start is the one you review.
  
  Go through each document one after the other. Per fact you encounter, check if it has an associated annotation. 
  
  * If not, report a missing annotation back to your caller and request one. Wait for the answer and then check it (see below). Start your report with they keyword `**Missing annotation**:`
  * If one is present, validate that it actually proofs the fact to be true. Read referenced source files if given and consider the specified user input. Be thorough and exact. Does the reference/ user input REALLY proof complete fact? Oftentimes, a part of a sentence or even just the way it was formulated (e.g. words like always or must) does not completely match with the source and proof given. If the fact is not 100% prooven by the specified source, report this back to your caller and continue. Start your report with the keyword `**Wrong fact**`. Include the fact in question together with what part of the fact and why it is not proofable.
  
  *One by one*: Don't read all the source material at the start and then work through the facts in one go. Handle each fact separately, read exactly the required sources and report back one by one.
  
  *Completeness*: The complete documentation consists of facts, so make sure that every part of the documentation is included in a fact and therefore validated to be true.
```

**Placeholders:**
- `[MODEL]` — REQUIRED: reviewer model per SKILL.md Model Selection
- `[FILE_LIST]` — REQUIRED: the list of files you modified or create

During its processing, the reviewer may report back with two different reports:

* **Missing annotation**: It seems like you forgot to annotate a fact with a `FACT-CHECK: <content>` content. Go back and find the source of truth you based that part of the documentation on. Report it **back** to the subagent **and** in parallel, add it to the documentation file
* **Wrong fact**: The subagent can not proof a fact you have written based on your given annotation. Read the report and reconsider. Is this fact really 100% true and proofable? Maybe it is only partly proofable. If you come to the same conclusion as the subagent, update this part of the documentation together with its annotation. If you require input from your human partner as a proof, always ask. If you still think the fact is correct leave it as is. It will be double-checked by your human partner later though.  
