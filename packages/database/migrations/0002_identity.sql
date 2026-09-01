-- ============================ users & auth ============================

CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT d7_uuid(),
  username         text NOT NULL,
  email            text NOT NULL,
  -- bcrypt/argon hash only. No plaintext, ever. Nullable for OAuth-first accounts.
  password_hash    text,
  display_name     text,
  avatar_url       text,
  bio              text,
  role             text NOT NULL DEFAULT 'listener' CHECK (role IN ('listener','artist','admin')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  email_verified   boolean NOT NULL DEFAULT false,
  country          text,
  locale           text NOT NULL DEFAULT 'en',
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  username_key text,
  email_key    text,
  CONSTRAINT users_username_fmt  CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,28}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username_key);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email_key);
CREATE TRIGGER users_keys BEFORE INSERT OR UPDATE OF username, email ON users
  FOR EACH ROW EXECUTE FUNCTION d7_keys_users();
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen_at DESC NULLS LAST);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                    text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','system')),
  explicit_filter          boolean NOT NULL DEFAULT true,
  autoplay                 boolean NOT NULL DEFAULT true,
  audio_quality            text NOT NULL DEFAULT 'normal' CHECK (audio_quality IN ('low','normal','high')),
  show_listening_history   boolean NOT NULL DEFAULT false,
  notify_followed_artists  boolean NOT NULL DEFAULT true,
  locale                   text NOT NULL DEFAULT 'en',
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_prefs_touch BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

-- Sessions are stored server-side so logout/remote-revoke is possible (not pure JWT).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id           uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  user_agent   text,
  ip_hash      text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_token_key UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id             uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  provider_user_id text NOT NULL,
  email          text,
  raw_profile    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_accounts_provider_uniq UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS oauth_accounts_user_idx ON oauth_accounts (user_id);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  purpose     text NOT NULL DEFAULT 'verify_email' CHECK (purpose IN ('verify_email','password_reset')),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_tokens_purpose_once UNIQUE (user_id, purpose, token_hash)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- ============================ subscriptions ============================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','premium')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','trialing','past_due','canceled','incomplete')),
  payment_provider    text NOT NULL DEFAULT 'manual',
  external_customer_id text,
  external_subscription_id text,
  price_cents         integer NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'USD',
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user
  ON subscriptions (user_id) WHERE status IN ('active','trialing','past_due','incomplete');
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
CREATE TRIGGER subs_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION d7_touch_updated_at();

CREATE TABLE IF NOT EXISTS payment_events (
  id            uuid PRIMARY KEY DEFAULT d7_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  external_id   text,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_dedupe UNIQUE (provider, external_id)
);
