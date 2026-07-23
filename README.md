# Curse of Death and Despair

Moduł dla:

- Foundry Virtual Tabletop 13, build 351
- D&D5e 5.3.3
- Simple Calendar Reborn 2.5.5 (wydanie dla Foundry 13)
- Dice So Nice

## Działanie

W wyznaczonym dniu aktywnego kalendarza główny MG publikuje na czacie osobną kartę dla każdej wybranej ofiary.

Po rozpoczęciu ataku moduł:

1. Rzuca `1d20`, aby ustalić, czy ofiara znajduje się w pobliżu paladyna. Domyślnie wynik `10` lub niższy oznacza sukces (10/20).
2. Rzuca `1d6`, aby wybrać atakowaną cechę: Strength, Dexterity, Constitution, Intelligence, Wisdom albo Charisma.
3. Udostępnia właścicielowi postaci oraz MG przycisk rzutu obronnego na wybraną cechę.
4. Przy obecności paladyna tymczasowo dodaje do rzutu jego aktualny modyfikator z Charyzmy.
5. Przy porażce rzuca skonfigurowaną utratę cechy (domyślnie `1d4`) i aktualizuje efekt na karcie postaci.

Efekt zmniejsza wynikową wartość cechy, lecz nie nadpisuje jej wartości bazowej. Usunięcie efektu natychmiast przywraca bazowe wartości.

Wynikowa wartość cechy nie spadnie poniżej 0. Po osiągnięciu 0 moduł wyświetla ostrzeżenie o śmiertelnym progu, ale nie zmienia automatycznie PW ani stanu postaci.

## Instalacja

1. Umieść zawartość paczki w katalogu:
   `Data/modules/curse-of-death-and-despair`
2. Włącz `Simple Calendar Reborn`, `Dice So Nice` oraz `Curse of Death and Despair`.
3. Uruchom świat ponownie.

## Konfiguracja

Przejdź do:

`Configure Settings → Module Settings → Curse of Death and Despair`

Dostępne ustawienia:

- ST rzutu obronnego — domyślnie 18.
- Szansa na bliskość paladyna — domyślnie 10/20.
- Awaryjna premia aury — domyślnie +3.
- Liczba dni między atakami — domyślnie 3.
- Formuła utraty cechy — domyślnie `1d4`.
- `Skonfiguruj ofiary` — wybór przeklętych postaci i źródła Aury Ochrony.

W panelu ofiar można także:

- utworzyć testowy atak bez zmiany harmonogramu,
- wyznaczyć następny termin od bieżącego dnia,
- usunąć wszystkie zarządzane efekty utraty cech z wybranych ofiar.

Zmiana odstępu dni automatycznie wyznacza następny atak od początku bieżącego dnia kalendarza.

## Zdjęcie klątwy

1. Usuń efekt `Curse of Death and Despair — utrata cech` z karty postaci. Możesz też zaznaczyć wyłącznie wyleczoną postać w otwartym panelu i użyć przycisku `Usuń efekty utraty cech`.
2. Odznacz wyleczoną postać i zapisz panel, aby nie otrzymywała kolejnych ataków.

## Uwagi

- Tylko główny MG wyznaczony przez Simple Calendar obsługuje harmonogram, co zapobiega podwójnym wiadomościom przy kilku zalogowanych MG.
- Wszystkie rzuty są publikowane przez standardowy mechanizm Foundry, dzięki czemu Dice So Nice wyświetla animacje automatycznie.
- Jeśli kalendarz zostanie przestawiony naprzód o wiele cykli, moduł odtworzy maksymalnie 20 pominiętych ataków i następnie przesunie harmonogram do przyszłości.
- Interfejs ma tłumaczenia polskie i angielskie zgodnie z językiem Foundry.
