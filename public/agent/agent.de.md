# Arbeiten mit dem App Builder

Der App Builder macht aus einer Beschreibung eine Haven-App: ein GitHub-Repository aus der Starter-Vorlage, eine Bereitstellung auf Cloudflare Workers, die sich bei jedem Push neu ausrollt, optional einen Cursor-Coding-Agenten, der die Beschreibung umsetzt, und die Installation in Haven. Er führt eine Liste der damit gebauten Apps.

## Was Agenten dürfen und was nicht

- Du kannst die Liste lesen, Builds und den Coding-Agenten verfolgen und Arbeit vorbereiten.
- Du startest nie selbst etwas nach außen. Ein Repository anlegen, auf Cloudflare veröffentlichen und einen Cursor-Lauf starten (der das Cursor-Kontingent des Benutzers verbraucht) passiert nur, wenn der Benutzer den Knopf drückt. `builder_new_app_prefill` und `builder_agent_follow_up_prefill` füllen die Seite aus und liefern die Beschriftung des Knopfs in der Sprache des Benutzers; bitte ihn, zu prüfen und zu drücken.
- Tokens und API-Schlüssel siehst du nie. Meldet `builder_get_context` ein Konto als nicht verbunden, bitte den Benutzer, es unter „Verbindungen und Einrichtung" zu verbinden.

## Woher die IDs kommen

- `appId`: `builder_apps_list`. Sie ist zugleich der Repository-Name und die App-ID.
- `undoStepId`: liefert `builder_apps_forget`.

## Eine neue App bauen

1. `builder_get_context`: `connections` prüfen (GitHub und Cloudflare sind nötig, Cursor ist optional) und dass kein Build läuft.
2. Aus dem Wunsch des Benutzers einen kurzen `name`, eine einzeilige `description` und ein `brief` machen: was die App tut, ihre Daten, ihre Seiten, in einfachen Worten. Danach arbeitet der Coding-Agent.
3. `builder_new_app_prefill` damit aufrufen. Hat der Benutzer schon ins Formular getippt, wird der Aufruf abgelehnt; frag nach und wiederhole ihn mit `replace` true.
4. `blockedBy` im Ergebnis lesen. Ist es gesetzt, sag dem Benutzer, was fehlt; sonst bitte ihn, den Bauen-Knopf zu drücken.
5. Den Build mit `builder_get_context` verfolgen (`build.currentStep`, `build.steps`, `failed`).

## Eine bestehende App kopieren

`builder_new_app_prefill` mit `mode` copy und `sourceUrl` (die URL eines GitHub-Repositorys oder der laufenden App). Der Builder schlägt die Quelle nach und übernimmt Name und Beschreibung; prüfe `form.source` und `form.sourceError`. Gib einen neuen `name` und ein `brief` mit, das sagt, was sich ändern soll.

## Eine App fortsetzen

`builder_apps_get` nennt `stage` und `nextAction`. `builder_app_open` zeigt die Seite der App und liefert die Beschriftung des Weiter-Knopfs: Der Benutzer drückt ihn, um zu veröffentlichen, die App zu Haven hinzuzufügen oder sie wieder der KI zu übergeben.

## Den Coding-Agenten verfolgen

`builder_agent_status` liefert den Stand des aktuellen Laufs, seine Zusammenfassung und Branches oder Pull Requests. Ist der Lauf fertig, schreibt `builder_agent_follow_up_prefill` die nächste Anweisung in das Feld des Agenten; der Benutzer sendet sie.

## Apps aus der Liste entfernen

`builder_apps_forget` entfernt nur den Listeneintrag; Repository, Worker und Haven-Installation laufen weiter. Sag das dazu. `builder_undo` holt die Einträge zurück, solange der App Builder geöffnet bleibt.
