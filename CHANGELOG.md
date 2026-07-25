# Changelog

## 0.3.8

- Dodano ustawienie MG określające zakres kary do leczenia z zaklęć: tylko ofiary klątwy albo wszystkie postacie.
- Dotychczasowy zakres „tylko ofiary klątwy” pozostaje ustawieniem domyślnym, więc aktualizacja nie zmienia istniejących zasad świata.
- Zakres można wybrać zarówno w ustawieniach modułu, jak i w sekcji ustawień zasad w konfiguratorze klątwy.
- Odpoczynki, eliksiry i mikstury nadal nie podlegają karze.
- Journal zasad pokazuje aktualnie wybrany zakres kary do leczenia.

## 0.3.7

- W konfiguracji klątwy zapisane ofiary są wyświetlane na górze listy, a pozostałe postacie poniżej.
- W obu grupach postacie zachowują kolejność alfabetyczną.
- Aktualnie wybrane źródło aury jest pierwszą pozycją listy; przy wyborze automatycznym na górze pozostaje opcja automatyczna.

## 0.3.6

- Każdy atak w Historii rzutów można niezależnie rozwinąć i zwinąć.
- Zwarte nagłówki pokazują numer ataku, datę, atakowaną cechę i wynik, dzięki czemu łatwiej znaleźć konkretny wpis.
- Historia otwiera się z wpisami domyślnie zwiniętymi, a stan rozwinięcia pozostaje zachowany podczas pracy w oknie.
- Zwijanie działa zarówno w edytowalnym widoku MG, jak i w udostępnionym widoku gracza, z zachowaniem ustawień widoczności danych.

## 0.3.5

- Przesunięto wyłącznie wyszukiwarkę ofiar o kolejne 16 px w górę.
- Równoważący dolny margines nadal zachowuje położenie listy ofiar i pozostałych elementów konfiguratora.
- Journal zasad nie ujawnia już ST/DC ataku klątwy.

## 0.3.4

- Przesunięto wyłącznie wyszukiwarkę ofiar o kolejne 16 px w górę.
- Zwiększony o tę samą wartość dolny margines zachowuje położenie listy ofiar i pozostałych elementów konfiguratora.

## 0.3.3

- Przesunięto wyłącznie wyszukiwarkę ofiar o dodatkowe 16 px w górę.
- Równoważący dolny margines zachowuje dotychczasowe położenie listy ofiar i wszystkich pozostałych elementów konfiguratora.

## 0.3.2

- Przesunięto samą wyszukiwarkę ofiar o 4 px w górę bez zmiany położenia pozostałych elementów konfiguratora.
- Wyszukiwarka otrzymała wyższą warstwę interfejsu, dzięki czemu lista ofiar nie zasłania już pola ani nie przechwytuje kliknięć.
- MG może odblokować panel szybkiego dostępu, przeciągnąć oba przyciski wspólnie w wybrane miejsce i ponownie zablokować ich pozycję.
- Położenie oraz stan blokady są zapamiętywane lokalnie dla przeglądarki MG.
- Po zmianie rozmiaru okna panel pozostaje w granicach widocznego obszaru.

## 0.3.1

- Powiększono konfigurator do 780 × 800 px i włączono ręczne skalowanie okna.
- Zmniejszono odstęp między nagłówkiem listy ofiar, opisem i wyszukiwarką.
- Usunięto z wierszy ofiar pola konkretnej daty: rok, miesiąc i dzień.
- Dodano osobną liczbę dni między atakami dla każdej ofiary oraz przycisk przywracający wartość ogólną.
- Ogólna liczba dni pozostaje wartością domyślną dla ofiar bez indywidualnego odstępu.
- Zmiana odstępu konkretnej ofiary wyznacza jej następny atak od bieżącego dnia, a niezmienione harmonogramy zachowują dotychczasowy termin.
- Istniejące terminy z wersji 0.3.0 są zachowywane podczas aktualizacji i nadal obsługiwane wewnętrznie przez Simple Calendar Reborn.
- Journal zasad pokazuje wartość ogólną i efektywne odstępy poszczególnych ofiar bez ujawniania dat następnych ataków.

## 0.3.0

- Przebudowano listę ofiar zgodnie z makietą: dodano wyszukiwarkę, osobny Roll Mode każdej ofiary oraz zachowano indywidualne pola daty.
- Ofiara mająca co najmniej 6 poziomów paladyna automatycznie otrzymuje własną Aurę Ochrony i nie wykonuje testu bliskości.
- Dodano trwałe statystyki i pełną historię rzutów osobno dla każdej ofiary.
- Historia zachowuje wyniki testu paladyna, losowania cechy, save’a i utraty cechy, a także atakowaną cechę, premię aury oraz wynik ataku.
- MG może edytować lub usuwać wpisy historii, poprawiać sumy i przeliczać je ponownie z zachowanych rzutów.
- MG może udostępniać każdemu graczowi osobne kategorie danych konkretnej ofiary.
- Dodano przypięty do interfejsu przycisk szybkiego dostępu do danych oraz, dla MG, do pełnej konfiguracji klątwy.
- Ustawienia zasad klątwy są dostępne również w zwijanej sekcji konfiguratora.

## 0.2.0

- Dodano wybór trybu widoczności rzutów postaci graczy.
- Wszystkie rzuty klątwy NPC są zawsze ślepymi rzutami MG.
- Przyciski kart czatu są dostępne wyłącznie dla właścicieli danej ofiary i MG.
- Naturalne 1 dodaje +1 do formuły utraty cechy po nieudanym rzucie.
- Naturalne 20 przyznaje przewagę w kolejnym rzucie obronnym przeciw klątwie.
- Dodano osobną datę pierwszego lub następnego ataku dla każdej ofiary.
- Dodano automatycznie tworzony i aktualizowany Journal z zasadami, bez ujawniania graczom dokładnych dat kolejnych ataków.
- Test bliskości paladyna zmieniono na 1k10 z domyślnym progiem 5.
- Ofiary odzyskują domyślnie o 3 PW mniej z każdego leczenia pochodzącego z zaklęcia; odpoczynki i mikstury są wyłączone.

## 0.1.3

- Naprawiono niewidoczną listę ofiar w oknie konfiguracji.
- Dodano tryb awaryjny dla światów używających niestandardowego typu aktora.
- Zmniejszono szerokość konfiguratora i usunięto zbędną pustą przestrzeń listy.

## 0.1.0

- Pierwsze wydanie.
- Harmonogram ataków oparty na aktywnym kalendarzu Simple Calendar Reborn.
- Obsługa wielu ofiar i automatyczne zapobieganie podwójnym wyzwoleniom.
- Losowanie obecności paladyna, atakowanej cechy i utraty punktów cechy.
- Rzuty obronne D&D5e z tymczasową premią Aury Ochrony.
- Odwracalny, kumulujący się Active Effect utraty cech.
- Integracja z Dice So Nice poprzez standardowe rzuty Foundry.
- Konfiguracja, test ręczny, reset harmonogramu i czyszczenie efektów.
- Tłumaczenia polskie i angielskie.
