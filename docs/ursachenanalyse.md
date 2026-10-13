# Lokale Ursachenanalyse: Quellstand, Grenzen und Praxistests

Stand dieser Beschreibung: 13. Oktober 2026. Sie beschreibt die Änderungen im aktuellen Quellbestand. Ein veröffentlichter Download kann älter sein. Die folgenden praktischen Versuche sind Prüfanleitungen; sie wurden durch diese Dokumentation nicht am Heimnetz ausgeführt.

## Bestandsaufnahme und Erweiterungen

| Bereich | Bereits vorhanden | In diesem Quellstand ergänzt |
| --- | --- | --- |
| Ping und Verlauf | Router-/Repeater-/Internetziele, Zeitvergleich, Lag-Marker, 30-Sekunden-Lag-Phasen | Messmodus, tatsächliche Abstände, lokale Messqualität und P95/P99 |
| Windows-Adapter | Verkehrszähler und Fehler-/Discard-Differenzen | Verwendung zeitlich überlappender Adapterbelege in Vorfällen |
| FRITZ!Box | Lesezugriff über TR-064, Mesh-Bild, WAN-/Gerätezähler und Routerhistorie | stabile MAC-Identitäten, Schema-/Altersprüfung, belegte Pfade, beobachtete Mesh-Änderungen und scrollbarer Mesh-Stammbaum |
| Auswertung | ausdrücklich gestartete Codex-Auswertung | zusätzliche lokale regelbasierte Vorfallsanalyse im Worker, ohne KI-Aufruf |
| Mehrere PCs | lokales Monitoring je PC | freiwillige TLS-Kopplung, zentrale Sammlung und begrenzte Offline-Puffer |
| Desktop | einzelner Start je Datenordner, Tray, Benutzer-Autostart, geordnetes Ende | optionales Close-to-Tray und begrenzte Crash-Wiederherstellung |
| Datenhaltung | JSONL-Verlauf, tägliche Rohdateien und Sitzungsabschlüsse | getrennte Aufbewahrungsregeln, Minutenaggregate und begrenzte Roharchive |
| Anmeldung | Routerkennwort im Arbeitsspeicher | ausdrückliche optionale DPAPI-Speicherung; geschützte PC-Kopplungsschlüssel |

Der Quellcode ist die Referenz: [Messqualität](../lib/measurement-quality.js), [Mesh-Belege](../lib/mesh-evidence.js), [Incident-Engine](../lib/incident-analysis.js), [Worker-Service](../lib/incident-service.js), [PC-Kopplung](../lib/peer-monitor.js), [Aufbewahrung](../lib/history-policy.js), [Secret-Store](../lib/secret-store.js), [Desktop-Hintergrundmodus](../desktop/background.cjs) und [Portable-Launcher](../scripts/portable-launcher.cs).

## Was ein Vorfall aussagt

Auffällige, gültige Ping-Messungen starten einen Vorfall; eine manuelle Lag-Markierung startet ein eigenes Beobachtungsfenster. Die Engine unterscheidet lokale Quellen, Adapter, Messsitzungen und Messperioden. Verspätete Peer-Daten können Historie ergänzen, beginnen aber keinen neuen aktuellen Ausfall. Für zeitliche Peer-Vergleiche muss die ermittelte Uhrenunsicherheit verwertbar sein; bei fehlendem oder unzuverlässigem Zeitabgleich bleibt die Zuordnung unklar.

Ein Vorfall enthält die betroffenen Ziele, Beginn/Ende, bis zu 60 Sekunden davor und danach, Messstatistik, verfügbaren Mesh-Kontext und Datenverkehr sowie mehrere mögliche Erklärungen. Vorher- und Nachherfenster werden nur bei ausreichender Datenabdeckung als vollständig bezeichnet. Direkt nach dem Ereignis ist die Nachbeobachtung noch offen. Beenden, Pause oder eine Messlücke sind keine gemessene Wiederherstellung der Verbindung. Beim geordneten Programmende erhält die Analyse einen Abschluss; fehlende Nachmessungen werden dabei nicht erfunden.

Der hochauflösende Analysepuffer umfasst höchstens fünf Minuten und ist zusätzlich mengenbegrenzt. Bei längeren Vorfällen können frühere Abschnitte und das Vorherfenster fehlen; die Kennzahlen gelten dann nur für die noch verfügbaren Messpunkte. Auch das Während-Fenster führt eine Vollständigkeitskennzeichnung. Ein gespeicherter abgeschlossener Vorfall bedeutet deshalb keine lückenlose Statistik über seine gesamte Dauer. Kann der Worker beim Beenden innerhalb von fünf Sekunden nicht fertig werden, meldet die App dies als Warnung; der letzte gespeicherte Zwischenstand bleibt erhalten.

Die Belegstufen **Stark unterstützt**, **Plausibler Verdacht** und **Unklar** sind qualitative Regeln. Es gibt keine statistisch kalibrierte Prozentzahl für die Schuld eines Kabels, Repeaters, Routers oder Providers. Stützende Beobachtungen, Gegenbelege, fehlende Daten und der nächste unterscheidende Vergleichstest bleiben getrennt.

Beispiele für zulässige Eingrenzungen:

- Nur ein PC meldet Auffälligkeiten, während ein zeitlich vergleichbarer zweiter PC dasselbe Routerziel unauffällig erreicht: Hinweis auf den beobachteten Pfad des ersten PCs. Ohne dessen eindeutige Topologie bleibt der konkrete Abschnitt offen.
- Der nahe Mesh-Knoten ist unauffällig, nachfolgende Ziele werden in denselben Messrunden auffällig: ein Zwischenabschnitt kann eingegrenzt werden, wenn die Box einen eindeutigen aktuellen Pfad und alle notwendigen Zuordnungen liefert.
- Der PC hat einen bestätigten gemeldeten LAN-Hop zum ersten Mesh-Repeater; dieser und das Gateway sind in mindestens zwei gemeinsamen Messrunden auffällig, ohne gleichzeitig gute Internetantwort: Verdacht auf den Zugangsabschnitt PC/Adapter/LAN/Port/direkt angeschlossener Repeater (`local_access`). Das unterscheidet weder diese Komponenten voneinander noch beweist es einen Kabeldefekt.
- Router/Gateway stabil, mehrere externe Ziele gleichzeitig auffällig: WAN/externer Weg ist verdächtig. Ein Lastverdacht benötigt zusätzlich ein wirklich überlappendes WAN-Zählerintervall und eine verfügbare Anschlussrate.
- Router-Ping auffällig, Antworten von Zielen hinter dem Router unauffällig: ICMP-Behandlung des Routers bleibt ein Gegenbeleg gegen einen allgemeinen Weiterleitungsausfall.
- Nur ein externes Ziel auffällig: Ziel oder Routing kann betroffen sein. Das beweist keine Störung des aktuellen Spielservers.

Fehlende Ping-Antworten sind fehlende ICMP-Antworten. Daraus folgen weder nachgewiesener TCP-/UDP-Verlust noch ein bewiesener Geräteausfall. PC-, Router- und Gerätezähler können dieselben Bytes enthalten und werden deshalb nicht als Gesamtverbrauch addiert. Eine fehlgeschlagene Routerabfrage beweist keine Mesh-Trennung. Ein gesunkener Linkwert ist keine direkte Funkstörungs- oder Interferenzmessung.

## Verkehrsvergleich vor, während und nach dem Vorfall

`trafficComparison.before`, `.during` und `.after` enthalten jeweils `from`, `to`, getrennte `pc`- und `wan`-Zusammenfassungen und `wanUtilization`. Während des Vorfalls werden bis zu 128 verfügbare Geräte einschließlich bekannter Geräte ohne passende Zähler aufgeführt; vorher und nachher höchstens vier Geräte nach Intervall-Durchsatz. `deviceCount`, `unavailableDeviceCount`, `devicesTruncated` und `intervalsTruncated` kennzeichnen fehlende bzw. aus Platzgründen ausgelassene Daten. Vorher und nachher umfassen jeweils 60 Sekunden; während umfasst das tatsächliche Beobachtungsfenster. Die bisherige Zusammenfassung `traffic` beschreibt weiterhin nur den Vorfall. PC-Daten werden auf Quelle, Sitzung, Messperiode und Adapter begrenzt; zentrale FRITZ!Box-Zähler erhalten ihre eigene Routersitzung. Die App schreibt eine Peer-Sitzung nicht auf zentrale Routerdaten um.

Die Richtungen `download` und `upload` führen Durchschnitt, Spitze und Anzahl gültiger Werte; bei Zählerintervallen zusätzlich Bytes des ganzen Intervalls und proportional zur zeitlichen Überlappung geschätzte Fenstermengen. `coverage` nennt die Grundlage (`intervals`, `points` oder `unknown`), erste/letzte Beobachtung, abgedeckte Millisekunden, Abdeckungsanteil, größte Lücke, Stichprobenzahl und `containsBoundaryIntervals`. `complete` setzt bei Intervallen ein bereits vergangenes Fenster, mindestens 99 % Abdeckung und höchstens eine Sekunde Lücke voraus. Einzelne Ratenpunkte ergeben keine vollständige Zeitabdeckung. Ein Gerätepeak enthält seinen tatsächlichen Zählerzeitraum in `peakInterval`; ein Zählerintervall kann über die Fenstergrenze reichen. Die angezeigte Intervallrate ist deshalb keine sekundengenaue Messung im Lag-Moment. Die Detailanzeige speichert höchstens vier PC-/WAN-Intervalle je Fenster; Aggregate verwenden alle angenommenen Messungen.

Der Hinweis `traffic_change` benötigt eine Baseline aus mindestens drei Intervallen mit mindestens 48 Sekunden/80 % Abdeckung und höchstens zehn Sekunden Lücke. Im Vorfall sind mindestens zwei Intervalle und 80 % Abdeckung nötig; beide Seiten dürfen keine über ihre Fenstergrenzen reichenden Zählerintervalle enthalten. Für dieselbe Quelle und Richtung muss der gemessene Durchschnitt mindestens doppelt so hoch und mindestens 5 Mbit/s höher sein. Diese feste Vergleichsregel ist kein Last-, Warteschlangen- oder Kausalitätsbeweis. Ein einzelnes aktives Gerät wird nicht allein wegen seines Verkehrs als Schuldiger benannt. Fehlende Werte bleiben unbekannt. Bei hoher Detailmenge kürzt die Analyse ausdrücklich gekennzeichnete Listen, damit ein Vorfall in die Größenbegrenzung des Verlaufs passt.

## Messmodus und Windows-Grenzen

**Standard** strebt ungefähr 1.000 ms an. **Präzision** strebt 250 ms für das Gateway und den ausgewählten Repeater am PC an; andere Ziele einschließlich Internet bleiben bei ungefähr 1.000 ms. Es werden keine parallelen Wiederholungsbatches gestartet. Überlange Messdauer, Scheduler-Verzögerung oder hoher CPU-Anteil des Node-Messprozesses erhöhen den lokalen Abstand bis 1.000 ms. Sinkt die Belastung, wird er wieder schrittweise reduziert. Die tatsächlichen Zeiten haben Vorrang vor dem Solltakt.

Die Lückenkennzeichnung verwendet den tatsächlichen Abstand: mehr als zwei Sekunden oder mehr als das Dreifache des geplanten Intervalls, wobei der größere Grenzwert gilt. Lokale Messfehler und fehlende Antworten sind unterschiedliche Ergebnisse. P95/P99 verwenden die Nearest-Rank-Methode auf erfolgreichen, endlichen, nicht negativen Antwortzeiten; echte Nullwerte bleiben gültig. Ohne gültige Antworten bleiben die Perzentile unbekannt. Aus Minutenaggregaten werden keine exakten Perzentile rekonstruiert.

Windows legt die Route für Ping, DNS und Lasttests fest. Die Adapterwahl allein erzwingt keinen Pfad; VPN, gleichzeitiges LAN/WLAN und Routingwechsel können die Zuordnung einschränken. Vor jedem numerischen IPv4-Ping-Ziel fragt die App über [GetBestInterface](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getbestinterface) den von Windows gemeldeten besten Interface-Index ab. Die PC-MAC wird nur dann als passende Grundlage für die Pfadzuordnung verwendet, wenn alle Proben der Messrunde den ausgewählten Adapter melden. Hostnamen liefern derzeit keine solche Zuordnung; IPv6 wird als Messziel nicht unterstützt. Eine Route kann sich zwischen Abfrage und Ping ändern; die Abfrage ist kein Paketmitschnitt. Ein bestätigter Mesh-Pfad bleibt eine Topologiebeobachtung, kein Nachweis der tatsächlich durchlaufenen Geräte. Windows-WLAN-Angaben können Standortfreigaben benötigen; die App ändert diese nicht. Kanalnummer und Signalstärke ersetzen keine Spektrumanalyse. Adapterzähler zeigen keinen eindeutigen Kabel-, Port- oder Treiberdefekt. FPS-, GPU-, CPU- und ausschließlich anwendungsinterne Ruckler bleiben ohne entsprechende Anwendungsmessung offen.

## FRITZ!Box- und Mesh-Grenzen

Die App verwendet dokumentierte Leseaktionen. Modell, FRITZ!OS, Benutzerrechte und Freigaben entscheiden darüber, was tatsächlich verfügbar ist. DSL-Werte werden bei einer Cable-Box nicht vorausgesetzt. Ein LAN-PC sieht weder den gesamten Haushalt noch jede Funkstrecke unmittelbar.

Eine Mesh-Beobachtung benötigt ein bekanntes Schema, geordnete Zeiten und stabile MAC-Identitäten. Im aktuellen Parser werden die Schemafassungen 1.0, 1.5, 1.6, 1.9, 4.11, 5.0, 6.7, 7.8 und 8.7 berücksichtigt; die vom konkreten Gerät gemeldete Version entscheidet. Unbekannte Schemata, gekürzte Daten, fehlende PC-MAC, mehrere Master oder mehrere mögliche aktive Pfade bleiben ausdrücklich unbekannt/mehrdeutig. Der bestätigte Pfad bezeichnet die eindeutigen verbundenen Links des Snapshots, keine gemessene Paketweiterleitung.

Änderungen werden zwischen zwei vollständigen, passenden Snapshots verglichen. Router-/Sitzungswechsel und große Beobachtungslücken beginnen eine neue Vergleichsbasis. Der genaue Änderungszeitpunkt zwischen den Abfragen ist unbekannt. Ein nicht mehr gemeldeter Knoten/Link ist keine bestätigte physische Trennung; ein expliziter Linkstatus ist stärkerer Beleg. IP-Adressen und kurzlebige Mesh-UIDs allein ersetzen keine stabile Geräteidentität.

Die [Mesh-Stammbaumansicht](../public/topology.js) ordnet den Master links an, nachfolgende Knoten rechts und getrennte Gruppen untereinander. Jeder Ast erhält einen eigenen Platzbereich; Knoten und Kantenbeschriftungen liegen außerhalb der anderen Knoten. Die Baumverbindungen stammen ausschließlich aus gemeldeten aktiven Links. Die zur Anordnung gewählte Elternbeziehung ist keine Messung der tatsächlichen Uplink- oder Weiterleitungsrichtung. Parallel-, Quer-, Selbst- und nicht aktive Verbindungen bleiben als zusätzliche Außenrouten und einzeln auswählbare Liste erhalten; Mehrdeutigkeit wird dadurch nicht zu einem eindeutigen Pfad umgedeutet. Verbindungen zu nicht enthaltenen Endpunkten werden mit Hinweis ausgelassen.

Große Netze lassen sich horizontal und vertikal scrollen. **−/+** und Strg+Mausrad ändern den Zoom zwischen 35 und 150 %; **Einpassen**, **Master** und **Auswahl** helfen bei der Navigation. Der kleinste Zoom erhält das Scrollen großer Netze. Auswahl, Zoom, Scrollposition und offene Zusatzverbindungen werden beim erneuten Zeichnen bewahrt; vorhandene MAC-/Interface-Identitäten erhalten die Auswahl auch bei wechselnden Mesh-UIDs. Nicht eindeutig wiedererkennbare Links erhalten keine erfundene dauerhafte Identität. Linkauswahl zeigt gemeldeten Zustand sowie RX/TX in der ursprünglichen Endpunktrichtung; diese Linkraten sind kein Internet-Speedtest. Die Ansicht und ihre Bedienung ändern keine Routerkonfiguration.

Reguläre Routerabfragen erfolgen ungefähr minütlich; auffällige Messungen können zusätzliche begrenzte Aufnahmen auslösen. Auch diese Momentaufnahmen können kurze Änderungen verpassen. Die HTTP-Digest-Anmeldung an TR-064 verschlüsselt die danach gelesenen Routerdaten nicht. TLS der PC-Kopplung ändert diesen Routerzugriff nicht.

## Optionale einmalige Windows-Ereignisaufzeichnung

Die automatische Erfassung ist zunächst ausgeschaltet. Eine ausdrückliche Aktivierung über `POST /api/incident-capture` mit `{ "enabled": true }` gestattet einen automatischen 15-Sekunden-Versuch beim nächsten beobachteten Vorfall. Optional wählt `sessionId` die bereits erkannte Spielprozess-Sitzung. Ohne Auswahl muss genau ein laufendes Spiel erkannt sein; bei mehreren Spielen oder fehlenden passenden Prozessen wartet die Erfassung. Eine laufende manuelle oder automatische Aufzeichnung verhindert einen parallelen Start.

Vor dem tatsächlichen Start verbraucht der Server die Aktivierung. Windows kann dafür eine Administratorfreigabe anfordern. Ablehnung, Helferfehler oder spätere Vorfälle starten keine weiteren unbeaufsichtigten Freigabeversuche. Ein weiterer Versuch benötigt eine neue ausdrückliche Aktivierung und frühestens zehn Minuten nach dem letzten Startversuch; die zehnminütige Sperre beginnt auch bei einem erfolglosen Versuch. `{ "enabled": false }`, Stoppen über `/api/games/capture/stop`, Zurücksetzen, Änderungen der Spielerkennung und App-Ende beenden die automatische Bereitschaft. Das reine Pausieren der Ping-/DNS-Überwachung ist kein Erfassungs-Stopp. Das ist eine begrenzte ETW-Metadatenaufzeichnung des lokalen Stacks, keine dauerhafte Paketaufzeichnung und kein Mitschnitt der Paketnutzlasten. Der Zustand steht unter `incidentCapture` in `/api/state`.

Ein zugeordnetes Ergebnis wird als `event` mit `kind: "incident-packets"`, passender `incidentId` und `capture` gespeichert. Die Vorfallsanalyse projiziert höchstens vier passende lokale Ergebnisse nach `packetCaptures`: Start/Ende, `relation`, Status, Qualität, Sende-/Empfangs-/Bytezähler, Retransmits, `losses.events`/`losses.buffers` sowie die festen Grenzen `scope: "local-stack-events"`, `deliveryBeyondRouter: "unknown"` und `causeEvidence: false`. Geordnete Erfassungszeiten dürfen nicht nach dem Ereigniszeitpunkt liegen; fremde IDs, Remote-Ergebnisse und erst zukünftig vorliegende Daten begründen keinen TCP-Hinweis.

`relation: "overlap"` bedeutet eine zeitliche Überlappung mit dem Vorfall, `"after"` eine spätere Erfassung innerhalb seines 60-Sekunden-Nachfensters. Eine erst nach dem Lag gestartete Erfassung belegt keinen Zustand während des Lags und keine frühere Ursache. Der Hinweis `tcp_retransmit` setzt eine überlappende abgeschlossene/gestoppte Erfassung, verwertbare Qualität und tatsächlich gezählte Retransmit-Ereignisse voraus. Die Zähler gelten für das gesamte Erfassungsintervall; ohne einzelne Ereigniszeiten sind sie nicht dem genauen Lag-Moment zugeordnet. Verlorene ETW-Ereignisse/-Puffer sind Erfassungsverluste, kein Netzwerkpaketverlust. Sende-/Empfangsdifferenzen und TCP-Retransmits beweisen weder Spiel-/UDP-Verlust noch die Zustellung hinter dem Router. Die automatisierte Vertragsprüfung ersetzt keinen tatsächlichen Windows-UAC-, ETW- oder Spieltest.

## PC-Kopplung, Schlüssel und Abmelden

PC-Kopplung ist zunächst aus. Ein PC wird als Zentrale, weitere als Mess-PCs eingerichtet. Die Zentrale lauscht standardmäßig auf Port 47831 und der gewählten lokalen IPv4-Adresse; `0.0.0.0` umfasst alle lokalen IPv4-Adapter. Die Programmoberfläche bleibt am separaten Loopback-Port. Firewallregeln, Benutzerrechte und Router-Portweiterleitungen werden nicht automatisch geändert.

Eine Einladung ist fünf Minuten gültig und einmal verwendbar. Sie enthält die Zentralen-ID, den Port, den SHA256-Zertifikat-Fingerabdruck und ein zufälliges Kopplungsgeheimnis. Adresse und Code auf dem vorgesehenen Mess-PC prüfen. Der Zertifikat-Pin wird vor Übertragung der HTTP-Anfrage geprüft; Übertragungen verwenden mindestens TLS 1.2. Nach der Kopplung authentifiziert ein individueller Token die begrenzten Messanfragen. Zeitabgleich, Einmal-Challenges und monoton steigende Folgenummern verhindern die erneute Übernahme identischer bestätigter Daten.

Übermittelt werden nur zugelassene Felder von Ping-, Adapter-, WLAN-, Netzwerk- und Geräte-/Topologiedaten. Lokale IP-/MAC-Adressen und Zeitstempel sind dabei private Daten. Routerkennwörter, Paketnutzlasten, beliebige Ereignistexte und vollständige Routerobjekte gehören nicht dazu. Die Zentrale kann höchstens 16 PCs koppeln. Ein Mess-PC puffert höchstens 2.000 Datensätze bzw. 4 MiB; bei voller Grenze entfallen die ältesten und der Drop-Zähler steigt. Der lokale Peer-Speicher enthält höchstens 1.000 empfangene Datensätze. Alte Nachlieferungen sind keine neuen Live-Ausfälle.

Die Minutenstatistik speichert je Peer-Identität die höchste bereits verarbeitete Ping-Folgenummer dauerhaft zusammen mit den Aggregaten (`peerSequences` in `history-rollups.jsonl`). Erneut nachgelieferte ältere/identische Folgenummern werden dadurch auch nach Wiederladen oder Kürzung des kurzfristigen Signaturcaches nicht nochmals gezählt. Diese Marken laufen nicht mit der Minutenaufbewahrung ab. Es sind höchstens 256 solche historischen Peer-Identitäten zulässig; weitere neue Identitäten erzeugen einen Fehler, statt eine alte Marke still zu entfernen. Das ist eine andere Grenze als die 16 gleichzeitig koppelbaren PCs und kein Nachweis lückenloser Übertragung. Beschädigte Marken werden beim Laden als Fehler behandelt.

Unterbrechungen zwischen PCs können Firewall, Standby, geschlossenes Programm, Routing oder Netzprobleme bedeuten. Der Verbindungsstatus allein beweist keine WLAN-Ursache. Ein Zugriff wird auf der Zentrale widerrufen; das lokale Entfernen am Mess-PC ersetzt diesen Widerruf nicht. Vor einem Rollenwechsel bestehende Kopplungen entfernen. Routeranmeldung und Peer-Schlüssel sind getrennte Geheimnisse.

Die Routeranmeldung wird standardmäßig nicht gespeichert. Die ausdrückliche Speicherwahl schützt JSON-Zugangsdaten mit Windows DPAPI **CurrentUser**. Peer-Schlüssel werden bei aktivierter Kopplung ebenfalls so geschützt. Auf dem Datenträger stehen geschützte Bytes, einschließlich bei atomaren temporären Dateien. Klartext wird ausschließlich für die Verarbeitung im Arbeitsspeicher bzw. direkt über die Helfer-Pipes benötigt; es gibt keine Klartext-Exportdatei. Der Schutz ist an den Windows-Benutzer gebunden und ersetzt keinen Schutz vor Schadsoftware unter demselben Konto. Auf einem anderen PC neu anmelden und neu koppeln; geschützte Dateien und Peer-Identität nicht als übertragbare Anmeldung behandeln.

## Hintergrundbetrieb und Aufbewahrung

Close-to-Tray ist zunächst aus. Nach Aktivierung blendet **Schließen** das Fenster aus, erhält das vorhandene Monitoring und dessen Renderer-Hotkey. **Vollständig beenden** und **Beenden** im Tray stoppen die App samt Messungen. Der vorhandene Benutzer-Autostart startet nach der Anmeldung. Das ist kein Windowsdienst und benötigt keine Administratorrechte. Vor Login, im Standby oder nach App-Ende wird nicht gemessen.

Node-Wiederherstellung ist nur bei aktiviertem Hintergrundmodus vorgesehen, höchstens dreimal je laufender App-Sitzung und nach bestätigtem Prozessende. Portable beendet die alte Desktopgeneration vor dem neuen Prozesspaar. Die installierte App verbindet das erhaltene Fenster mit dem neuen Server. Standardbetrieb, explizites Beenden und geordnetes Windows-Ende lösen keinen solchen Neustart aus. Die Messlücke steht im lokalen Desktopjournal; aufgebrauchtes Budget oder fehlgeschlagener Start ist kein Erfolg. Ein ursprünglicher Prozessabbruch kann die zuletzt noch nicht bestätigte Schreiboperation verlieren.

| Speicherbereich | Standard | Weitere feste Grenzen / Bedeutung |
| --- | --- | --- |
| Rohe Pings im aktiven Verlauf | 24 Stunden | konfigurierbar 1–168 Stunden; globaler Verlauf kann früher kürzen |
| Sonstige reguläre Verlaufseinträge | bis sieben Tage | keine Garantie für volle sieben Tage bei hoher Datenmenge |
| Vorfälle, Mesh-/Routerereignisse und Diagnosen im Verlauf | 365 Tage | konfigurierbar 31–3.650 Tage; Mengen-/Bytegrenzen bleiben wirksam |
| Minutenaggregate | 30 Tage | konfigurierbar 1–3.650 Tage; höchstens 200.000 Minutenaggregate und 96 MiB Datei |
| Tägliche Roharchive | 30 Tage, zusammen 256 MiB | konfigurierbar 1–3.650 Tage und 1 MiB–8 GiB; ganze älteste Tagesdateien werden entfernt |
| Aktiver HistoryStore | 12.000 Einträge | bis 16 MiB Speicher, 32 MiB aktive Datei und 64 KiB je Eintrag; geschützte Typen werden bevorzugt erhalten |
| Incident-Engine | letzte fünf Minuten Kontext | bis 8.000 Kontextdatensätze / 8 MiB, 50 engine-interne Vorfälle; Detailkürzungen werden bezeichnet |
| Worker-Eingangsqueue | bis 2.000 Datensätze | Drop-Zähler bei Überlauf; keine lückenlose Erfassung behaupten |
| Roharchiv-Schreibqueue | bis 4 MiB einschließlich wartender und laufender Batches | Batch-Freigabe nach 500 ms oder ab 256 KiB; Reservierung für Verlustmeldung, Drops werden als Messlücke bezeichnet |
| Peer-Ping-Marken der Minutenstatistik | höchstens 256 historische Peer-Identitäten | höchste verarbeitete Folgenummer dauerhaft; kein stilles Altern/Entfernen bei erreichtem Limit |

Die Regeln begrenzen keinen gesamten Datenordner: Codex-Diagnosedateien, Sitzungsabschlüsse, Desktopjournale und `.secrets` sind eigene Bereiche. Die Roharchivwartung erfolgt ungefähr minütlich; zwischen Wartungsläufen können Dateien über eine Grenze wachsen. Bei sehr kleinem Größenlimit kann auch eine aktuelle Tagesdatei entfernt werden. Vor Verringerung der Aufbewahrung benötigte Messprotokolle sichern. Die gesetzten Grenzen sind Aufbewahrungsziele; Quellgrenzen, Messpausen, Drops und Abstürze können früher zu fehlenden Daten führen.

Die 500-ms-Sammelzeit ist keine garantierte Plattenlatenz. Übersteigt die Roh-Schreibqueue ihre Grenze, werden neue Rohdatensätze verworfen; Drop-Zähler, Zeitraum und eine begrenzte `measurement-gap`-Meldung benennen den Verlust. Die Verlustmeldung kann erst bei erfolgreichem Schreiben dauerhaft gespeichert werden. Ein Schreibfehler erscheint als Fehler und löst keine automatische Wiederholung aus. Diese Archivlücke ist kein Netzwerkausfallbeleg; aktiver Verlauf, Analysequeue und tägliches Roharchiv haben getrennte Grenzen.

## Lokale APIs und Einstellungen

Die folgenden Endpunkte gehören zur lokalen Programmoberfläche. Schreibzugriffe erfordern das vorhandene Sitzungstoken und gültige Origin-/Host-Prüfungen. Sie sind keine frei erreichbare LAN-Steuerungs-API. Für den konkreten Start den zufälligen Loopback-Port verwenden.

| Vertrag | Verwendung |
| --- | --- |
| `GET /api/state` | aktueller Zustand einschließlich Messqualität und Analysezustand |
| `GET /api/incidents` | bis zu 500 verfügbare gespeicherte und laufende Vorfälle; Live-Zustand hält bis zu 100 |
| `POST /api/measurement` | Messmodus, JSON `{ "mode": "standard" }` oder `{ "mode": "precision" }` |
| `POST /api/incident-capture` | einmalige optionale 15-Sekunden-Erfassung aktivieren/deaktivieren, JSON `enabled` und optional erkannte Spiel-`sessionId`; kein automatischer wiederholter UAC-Versuch |
| `POST /api/history-policy` | validierte Aufbewahrungswahl, Felder `pingHours`, `rollupDays`, `eventDays`, `archiveMaxBytes`, `archiveMaxDays` |
| `GET /api/peers` | PC-Konfiguration, Kopplungs- und Übertragungsstatus |
| `POST /api/peers/configure` | `enabled`, `role` (`central`/`agent`), Name und lokale Empfangsadresse/Port |
| `POST /api/peers/pairing` | einmalige Einladung der eingeschalteten Zentrale |
| `POST /api/peers/pair` | Mess-PC koppeln: lokale Adresse, Zentralen-ID, Port, Pin, Kopplungsgeheimnis |
| `POST /api/peers/revoke` | Zugriff/Verbindung anhand `peerId` entfernen; Widerruf auf der Zentrale durchführen |
| `POST /api/fritzbox/connect` | Routeranmeldung; Speicherung nur mit ausdrücklichem `remember: true` |
| `POST /api/fritzbox/forget` | gespeicherte Routeranmeldung löschen und Speicherwahl ausschalten |

Desktop-Hintergrundwahl läuft ausschließlich über die schmale Electron-Bridge `desktopBackgroundMonitoring.get()`, `.set(boolean)`, `.quit()` und `.onStatus(callback)`. Die Bridge stellt keine Dateipfade, Shellbefehle oder Routerkennwörter bereit. Router-Speicherwahl und ausdrückliches Vergessen gehören zur Routeranmeldung; PC-Kopplung ist davon unabhängig.

## Praxistests A–F: noch am konkreten Aufbau auszuführen

### Traffic-Auflösung und 100-ms-Laggrenze ab 1.2.0

Automatische Ping-Spitzen beginnen bei **100 ms einschließlich**. Eine durchschnittlich erhöhte Latenz über 50 ms kann weiterhin eine separate Warnung ergeben; ICMP-Verluste werden unabhängig davon beobachtet. Ein erfolgreicher Ping unter 100 ms beendet die Spike-Phase, sobald alle betroffenen Ziele entsprechend gemessen wurden. Für positive Vergleichsbelege eines unauffälligen nahen Mesh-Knotens wird weiterhin die konservativere 50-ms-Grenze verwendet.

Der PC liest normalerweise jede Sekunde native Windows-Adapterzähler aus einem separaten dauerhaften Messhelfer. Dafür wird kein neuer PowerShell-/CIM-Prozess je Messpunkt gestartet. FRITZ!Box-WAN-Zähler werden normalerweise alle zwei Sekunden gelesen, Geräte-Mesh-Zähler frühestens alle fünf Sekunden. Diese kleinen Abfragen verwenden die laufende Routersitzung und rufen keine kompletten Hostlisten, Logs oder DSL-Diagnosen ab. Vollabfragen bleiben bei ungefähr 60 Sekunden, bei Lag-Anforderung frühestens nach 30 Sekunden. Langsame Abfragen oder große Antworten verlängern den Abstand; Fehler, tatsächliche Messdauer und Sollabstände werden sichtbar gehalten. Ein selbst erzeugter Lag lässt sich trotzdem nur durch einen Praxistest während des Spielens ausschließen.

`kind: "traffic"` innerhalb vorhandener FRITZ!Box-Verlaufseinträge bezeichnet reine Traffic-Aufnahmen. Sie enthalten keine kopierten Mesh-Graphen und erneuern nicht das Alter der letzten Topologie. WAN-Raten verwenden beobachtete Abfragefenster und weisen deren Zeitunsicherheit aus; der interne Aktualisierungstakt der Routerzähler ist unbekannt. Ohne gültiges Beobachtungsfenster wird keine präzise WAN-Rate erfunden. Gerätezähler verwenden ihre gemeldeten Routerzeitpunkte. Unveränderte Zeitpunkte sind keine neue Nullmessung. Router- und PC-Uhr sind nicht automatisch synchronisiert; der Vorfall nennt diese Grenze ausdrücklich. Zählerzeitpunkte mehr als zwei Sekunden nach ihrem Empfang werden nicht zur Lag-Zuordnung verwendet.

Die Gerätetabelle zeigt die tatsächliche volle Intervallmenge und -rate sowie ausdrücklich geschätzte Mengen innerhalb einer Teilüberlappung. Ein 60-Sekunden-Zähler bleibt ein 60-Sekunden-Zähler, selbst bei fünfsekündiger Abfrage. Ohne direkten Ping zu einem Gerät bleibt dessen Ping unbekannt. Weder konkrete Paketnutzlasten noch die verursachende App eines fremden Geräts werden daraus abgeleitet. Schnelle Traffic-Einträge behalten die vorhandenen Größen- und Aufbewahrungsgrenzen; ein Fast-Eintrag enthält höchstens 128 Geräte und ein 44-KiB-Gerätebudget. Kürzungen sind gekennzeichnet.

Validierung der neuen Messpfade umfasst isolierte Tests für 99,99/100 ms, unveränderte Routerzähler, echte Intervallenden statt Antwortzeit, fehlende/abweichende Routerzeit, gemeinsame WAN-Baseline, Pausen/Reset/Disconnect, Backoff sowie unverändertes Topologiealter. Ein realer Windows-Adaptertest prüft die Wiederverwendung des Messprozesses; FRITZ!Box- und Mehr-PC-Szenarien sind simuliert und müssen am konkreten Heimnetz bestätigt werden.

Stand 13.10.2026, Version 1.2.0: **624/624 Modultests bestanden**, Syntaxprüfung bestanden, Browserprüfung eines Vorfalls über echten Monitor, Analyse-Worker und HTTP-API mit synthetischen Netzwerkdaten bestanden. Die zusätzlichen Browserprüfungen bestätigen 100-ms-Grenze, Intervallanzeige, Gerätezuordnung und unveränderten Mesh-DOM bei schnellen Traffic-Polls. Portable und Installer einschließlich SHA256/SHA512, Update-Feed und Paketinhalt wurden gebaut und geprüft. Nach Freigabe der lokalen Windows-Ausführungsumgebung haben beide Desktop-Starttests mit isolierten Daten, Speicherung/Neustart und geordnetem Ende bestanden. Der zuvor ausschließlich in der eingeschränkten Sitzung beobachtete GPU-Startfehler trat dabei nicht mehr auf. Der vollständige GitHub-Actions-Lauf [38416966395](https://github.com/RoveHD/Netzwerk-Kompass-/actions/runs/38416966395) hat denselben Release-Commit `db711573af7f958269ffac5f0fb79696a17e05e9` einschließlich 624 Tests, NSIS-Installation/Deinstallation und Portable-Start erfolgreich geprüft. Diese Prüfungen bestätigen keine Diagnose am realen FRITZ!Mesh.

Für jeden Test Adapter, PC-Namen, Zieladressen, Verbindungskette, Uhrzeiten und aktivierte Messoptionen notieren. Mindestens 60 Sekunden Leerlauf davor und danach erfassen. Bei geändertem Adapter oder Aufbau eine neue Messperiode beginnen. Lasttests bewusst starten, nicht während eines wichtigen Matches. Keine automatisierte Fixture als realen LAN-/WLAN-Versuch ausgeben.

### A: Leerlauf am Router und am Repeater

Einen PC direkt per LAN am Router und anschließend per LAN am tatsächlich genutzten Repeater vergleichen. Router, nahen Repeater und zwei externe Ziele überwachen. Physische Anschlussreihenfolge dokumentieren und mit einem aktuellen FRITZ!Box-Snapshot vergleichen. Prüfen: Der erste Aufbau wird nicht als Repeaterpfad ausgegeben; eine fehlende oder mehrdeutige MAC-Zuordnung bleibt unbekannt. Unterschiede liefern eine Ausgangsbasis, noch keinen Defektnachweis.

### B: Zwei PCs auf verschiedenen Mesh-Pfaden

Zwei ausdrücklich gekoppelte PCs parallel an verschiedenen verfügbaren Anschlüssen messen lassen. Soweit vorhanden einen nahen Knoten und Ziele hinter dem vermuteten gemeinsamen Uplink aufnehmen. Prüfen: zeitlicher Vergleich trennt Geräte-ID, Adapter und Sitzung; ein gemeinsamer Abschnitt wird nur bei belegten Pfaden benannt. Wenn beide PCs gleichzeitig auffällig sind, bleibt ohne weitere Messpunkte offen, welcher gemeinsame Abschnitt betroffen ist.

### C: Kontrollierte lokale Unterbrechung und Wiederkehr

An einem eigenen Test-PC seine lokale LAN-Verbindung kurz trennen und wiederherstellen; den zweiten PC unverändert messen lassen. Beginn/Ende manuell protokollieren. Prüfen: fehlende Antworten, lokale Messfehler und Adapterwechsel bleiben getrennt; nur tatsächlich wieder gemessene gute Werte belegen die Erholung. Ein PC-spezifisches Problem darf nicht allein als gesamter Mesh-/Provider-Ausfall klassifiziert werden. Der mechanisch ausgeführte Test beweist nicht, dass spätere ähnliche Symptome dieselbe Ursache haben.

### D: Bewusst erzeugte WAN-Last

Bei stabiler LAN-Verbindung und verfügbarem Routerzugriff einen begrenzten Upload-/Downloadtest starten und anschließend vollständig stoppen. Gleichzeitig Router und mindestens zwei externe Ziele messen. Prüfen: Lastzustand ist markiert, WAN-Verbrauch wird nur aus einem gültigen Zählerintervall abgeleitet, PC- und Routerbytes werden nicht addiert. Bleibt der Router stabil und steigen externe Latenzen gemeinsam unter Last, kann ein Last-/Warteschlangenverdacht entstehen. Fehlende Anschlussrate oder zu grobe Routerintervalle bleiben fehlende Belege.

### E: Fehlende Routerdaten und unzuverlässige PC-Verbindung

Routeranmeldung in der App trennen oder bewusst ohne Freigabe arbeiten; einen gekoppelten Mess-PC später pausieren, schließen oder in Standby schicken. Prüfen: keine Routerantwort erzeugt keinen erfundenen Mesh-Disconnect; der ausgefallene Mess-PC wird nicht automatisch als WLAN-Ausfall gewertet. Nach dem Fortsetzen dürfen gepufferte Messungen Historie ergänzen, ohne aktuelle Vorfälle aus alten Zeitstempeln zu erzeugen. Bei großer Uhrenunsicherheit darf kein scheinbar genauer zeitgleicher Ursachenbeleg erscheinen.

### F: Hintergrund, Wiederherstellung, Login und Widerruf

In einem isolierten Testdatenordner Close-to-Tray aktivieren, das Fenster schließen und über den vorhandenen Lag-Hotkey markieren. Prüfen: Markierung und neue Messungen erscheinen beim Wiederöffnen. **Vollständig beenden** muss alle App-Messungen stoppen. Ein erzwungener Node-Abbruch sollte nur in diesem isolierten Aufbau getestet werden: vorher Daten sichern, anschließend Journal, Lücke, höchstens drei Wiederherstellungen und alte Prozessgenerationen kontrollieren. Danach normal starten, optionalen Benutzer-Autostart nach Ab-/Anmeldung prüfen und unbeobachtete Zeit als Lücke behandeln. Gespeicherte Routeranmeldung vergessen und PC-Zugriff auf der Zentrale widerrufen; ein widerrufener oder mit falschem Zertifikat-Pin konfigurierter PC darf keine neuen Daten liefern. Ein echter Windows-Login-, Standby- oder Repeatertest ist damit erst nach seiner tatsächlichen Durchführung bestätigt.

## Automatisierte Checks und offener Nachweis

Ausgeführt am 13. Oktober 2026 im lokalen Entwicklungsstand:

- `npm test`: **624/624 bestanden**, keine übersprungenen Tests. `npm run check` und `git diff --check` ebenfalls erfolgreich.
- Browserregressionen für Live-Verlauf, vergrößertes Nachrücken, Maus-/Tastaturbedienung, Scrollzustand, Lag-Traffic und schmale Ansichten bestanden.
- Integration mit echtem `Monitor.start`, Node-Analyseworker und HTTP-API: Ein synthetisches Mesh mit PC → C → B → Master wurde eingelesen, der Abschnitt C → B eingegrenzt und der gespeicherte Vorfall mit Traffic-Vergleich und historischen Linkdetails in der Oberfläche geöffnet. Die Netzwerte waren Testdaten; dies ist kein Test einer physischen Mesh-Strecke.
- Portable und Installer für Version 1.2.0 erstellt. Beide Desktop-Laufzeiten lokal mit isolierten Daten gestartet, Fenster geladen, Speicherung/Neustart und geordnetes Ende geprüft. Der echte Benutzer-Autostart wurde dabei nicht verändert. NSIS-Installation, Windows-Registrierung, Deinstallation und Erhalt der Benutzerdaten wurden auf dem separaten GitHub-Windows-Runner erfolgreich geprüft.
- Echte Windows-DPAPI-Roundtrips, lokale TLS-Verbindungen sowie Windows-Routenabfrage zu `127.0.0.1` geprüft. Kopplung über zwei physische PCs, Windows-Neustart, reale FRITZ!Box-Modelle, mehrtägiger Betrieb und Gaming-Verhalten bleiben Praxistests.

Der geprüfte Release-Stand ist Version 1.2.0, Commit `db711573af7f958269ffac5f0fb79696a17e05e9`. Der komplette erfolgreiche Actions-Lauf dieses Commits liefert die Release-Artefakte. Zwei separate Tag-Läufe scheiterten am zu knappen 10-Sekunden-Kompilierlimit des Launcher-Tests; das Compiler-Budget wurde danach separat auf 30 Sekunden begrenzt, während Harness-Laufzeit und Assertions unverändert bleiben.

Gezielte Tests: `node --test test/measurement-quality.test.js test/incident-service.test.js` prüft Messgrenzen/Perzentile und den echten Node-Worker einschließlich Queue-Abschluss und Wiederladen persistierter Endanalysen. Desktop-/Secret-Prüfungen liegen in `test/background-monitoring.test.js`, `test/desktop-background.test.js`, `test/portable-background.test.js`, `test/secret-store.test.js` und den vorhandenen Runtime-/Updater-Tests. Der portable Prozessversuch verwendet kompilierten Fixture-Code und echte isolierte Prozesse, keinen produktiven Router und kein Spiel. DPAPI-Roundtrips verwenden isolierte Testdaten; sie bestätigen die implementierte Windows-Verschlüsselung, keine vollständige Sicherheitsprüfung eines PCs.

[Topologie-Geometrietests](../test/topology.test.js) prüfen große Sterne, lange Ketten, ungleich große Äste, getrennte Gruppen, Quer-/Parallelverbindungen und UIDwechsel. [Das isolierte Browser-Prüfskript](../scripts/topology-tree-ui-check.mjs) verwendet ausschließlich synthetische Daten für 1400/768/390/320 Pixel, Auswahl, Zoom und Scrollen. [Vorfalls-Tests](../test/incident-analysis.test.js) prüfen unter anderem den Verkehrsvergleich, unzureichende Baselines, tatsächliche gleichzeitige Pfadbelege sowie überlappende und spätere Paketaufzeichnungen. Solche Fixtures bestätigen die implementierten Regeln, keinen Defekt oder beobachteten Aufbau im Heimnetz. Dieser Dokumentationsabgleich selbst führt keine Testsuite, keinen Build und keine Hardwareprüfung aus.

`npm test` und `npm run check` prüfen den gesamten aktuellen Stand. Paket-Smokes und Browserchecks sind separat auszuführen; ihre Existenz ist kein Nachweis, dass der aktuelle Release-Build bereits geprüft wurde. Physische Mesh-Ketten, gerätespezifische FRITZ!OS-Fähigkeiten, WLAN-Freigaben, Firewall, Spiel-/Schutzsoftware, Standby und echte Windows-Anmeldung benötigen die dokumentierten Praxistests am betreffenden Aufbau.
