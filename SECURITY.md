# Security

Не публикуйте уязвимость с production-данными в открытом issue. Передайте её владельцу решения через согласованный private security contact.

Инженерная модель угроз, обработка геолокации, platform attestation, ограничения и рекомендации по персональным данным описаны в [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md).

Никогда не коммитьте `.env`, Google service-account JSON, signing keys, QR secrets, production database или raw location export.
