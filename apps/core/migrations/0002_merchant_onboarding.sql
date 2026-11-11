-- Add onboarding fields to merchants table
ALTER TABLE merchants ADD COLUMN owner_name TEXT;
ALTER TABLE merchants ADD COLUMN phone_number TEXT;
ALTER TABLE merchants ADD COLUMN can_provide_nid INTEGER DEFAULT 0;
ALTER TABLE merchants ADD COLUMN onboarding_step TEXT DEFAULT 'completed';
