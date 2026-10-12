# Signal — Netzwerk-Kompass

Lokales Desktop-Theme mit warmem Schiefer (#16181A), Karten (#1D2023), Rahmen (#2A2E32) und Signal-Türkis (#3FC1B0). Grün, Amber und Rot tragen ausschließlich Messstatus.

Geist für Oberfläche/Überschriften, Geist Mono mit tabellarischen Ziffern für Messwerte; große Werte 32 px, Einheiten 14 px direkt daneben. Beide Schriften liegen einschließlich OFL-Lizenz unter public/fonts.

- Globale 4-px-Signalleiste: letzte 60 tatsächlich gemessene Pings, Zeitpunkt/Wert beim Zeigen, Klick öffnet Verlauf. Lokale Messfehler sind keine Verluste.
- 48-px-Statusring: ein Segment je aktivem Messziel, kompakte Statuszeile und eine Aktion; Diagnosekontext bleibt über Info erreichbar.
- Einheitliche 6-px-Radien, keine Schatten/Verläufe/Leuchteffekte. Türkise aktive Navigation mit 2-px-Markierung.
- Latenz: 1,5-px-Linie, 8-%-Fläche, horizontales Raster und gestrichelte 30-ms-Schwelle; rote Verluste auf der Zeitachse.
- Zahlenfade 150 ms, kurze Seiten-/Dialogwechsel und datengetriebene Signalanimation; reduzierte Bewegung wird berücksichtigt.

Zentrale Dateien: public/graphite.css, public/live-signal.js/css, public/overview.js/css, public/ui-presentation.js, public/ping-chart.js/css. Lokale Asset-Auslieferung in server.js und vollständige Windows-Paketierung in scripts/build-portable.ps1.

Browserprüfung: scripts/graphite-ui-check.mjs mit isolierten synthetischen Messdaten; Ergebnisse in test-artifacts/signal-ui (nicht versioniert).

Die Übersicht folgt der bereitgestellten Referenz: Statusring im Kopf, vier flache Messkarten mit tatsächlichen Verläufen, Latenz/Qualität, Datenverkehr/letzte Messungen und kompakte Geräte-/Ereignislisten. Keine erfundenen Tagesvergleiche, Tests oder Gerätewerte. Layout: public/dashboard.css; vorhandene Messdaten: public/overview-details.js.
