# Relationship Graph

This file is the semantic relationship source for the example vault. Ordinary
wikilinks elsewhere in the vault are evidence links only; they do not create
edges automatically.

## Node Types

| ID | Name | Visual family |
| --- | --- | --- |
| character | Character | character |
| place | Place | place |

## Relation Types

| ID | Name | Visual family | Directed | Reverse name |
| --- | --- | --- | --- | --- |
| near | Near | custom | false | Near |

## Nodes

| ID | Name | Aliases | Type | Active from | Revealed at | Inactive from | Visibility | Confidence | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| char:example | Character name | Character nickname | character | @start | [[manuscript/Part-1_Beginning/Chapter-1.md\|Chapter 1]] | | public | confirmed | [[characters.md#Character name\|Character name]] |
| place:example | Place name | Alternate place name | place | @start | [[manuscript/Part-1_Beginning/Chapter-1.md\|Chapter 1]] | | public | confirmed | [[setting-index.md#Places\|Places]] |

## Relations

| ID | Source | Relation | Target | Active from | Revealed at | Inactive from | Visibility | Confidence | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rel:r001 | @char:example | near | @place:example | @start | [[manuscript/Part-1_Beginning/Chapter-1.md\|Chapter 1]] | | public | confirmed | [[manuscript/Part-1_Beginning/Chapter-1.md#Chapter 1: Your chapter title\|Chapter 1]] |
