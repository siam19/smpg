-- Store AES-GCM encrypted API keys so the self-hosted owner can view & copy credentials anytime in Telegram
ALTER TABLE api_keys ADD COLUMN encrypted_key TEXT;
