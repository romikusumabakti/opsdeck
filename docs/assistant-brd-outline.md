# Assistant BRD draft outline

The code assistant turns a conversation into a BRD section draft
(`lib/assistant/drafts.ts`). Its section headings follow the structure of the
BRDs Acme writes for clients: the heading levels and order were taken from an
existing client BRD (headings only), with every product-, client- or
module-specific name replaced by a placeholder. No client content is kept here.

## Source structure

A BRD opens with an introduction, then has one chapter per module of the
product. `<module>` and `<entity>` stand for the module and the record it
manages.

```text
1  Introduction
   1.1  Business Requirement Summary
   1.2  Organization Profile
   1.3  Deliverables/Scope
        1.3.1  In Scope
        1.3.2  Out of Scope
   1.4  System Architecture Overview
2  Timeline & Process Flow
   2.1  Overview
   2.2  <one subsection per processing day or stage>
   2.3  End-to-End Process Flow Diagram
3+ <module>                          (one chapter per module)
   n.1  Business Requirement Summary
   n.2  Organization Profile
   n.3  Deliverables/Scope
   n.4  General Business Requirement
        n.4.1  Roles
        n.4.2  Status Role
        n.4.3  User Activity
   n.5  Business Requirement
        n.5.1  Flow Diagram
        n.5.2  Business Process
        n.5.3  List of <entity>
        n.5.4  Form Create New <entity>
        n.5.5  Detail <entity>
        n.5.6  Import Data
```

## Draft sections

A draft from the assistant is one module chapter. Its `sections[].heading`
values are taken from this list, in this order; a section the conversation
says nothing about is left out rather than invented. Content is written in
Indonesian; anything the conversation does not settle is marked
"Perlu konfirmasi BA".

1. Business Requirement Summary
2. Organization Profile
3. Deliverables/Scope (In Scope and Out of Scope in the body)
4. Roles
5. Status Role
6. User Activity
7. Flow Diagram (described in text)
8. Business Process
9. List of `<entity>`
10. Form Create New `<entity>`
11. Detail `<entity>`
12. Import Data

The list lives in code as `BRD_SECTION_HEADINGS`; keep both in step.
