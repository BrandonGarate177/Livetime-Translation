#!/usr/bin/env bash
# Generates 8kHz mono test clips with macOS `say`. Missing voices are skipped; install them in
# System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.
set -u
cd "$(dirname "$0")/../test-audio"
gen() { # name voice text
  if say -v "$2" -o "$1.wav" --data-format=LEI16@8000 "$3" 2>/dev/null; then echo "ok   $1.wav ($2)"; else echo "skip $1.wav (voice $2 not installed)"; fi
}
gen en-hello Samantha "Hi Olena, this is a judge from the hackathon. How is your day going? Where are you calling from?"
gen es-hello Paulina "Hola, me llamo Diego. Estoy muy bien, gracias. Estoy en Madrid hoy."
gen ru-hello Milena "Привет, меня зовут Олена. У меня всё хорошо, спасибо. Я звоню из Киева."
gen pl-hello Zosia "Cześć, mam na imię Kasia. Wszystko w porządku, dziękuję. Dzwonię z Warszawy."
gen uk-hello Lesya "Привіт, мене звати Олена. У мене все добре, дякую. Я телефоную з Києва."
