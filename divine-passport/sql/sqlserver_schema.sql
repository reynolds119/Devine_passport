-- Divine Passport schema for Microsoft SQL Server / SQL Server Express.
-- Run this script in SQL Server Management Studio. It creates divine_passport
-- when it does not exist, then creates the application tables if missing.
-- This is a new schema; it does not import Supabase data or delete records.

IF DB_ID(N'divine_passport') IS NULL
BEGIN
    CREATE DATABASE [divine_passport];
END
GO

USE [divine_passport];
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.users (
        id CHAR(32) NOT NULL CONSTRAINT PK_users PRIMARY KEY,
        email NVARCHAR(254) NULL,
        password_hash NVARCHAR(200) NOT NULL,
        full_name NVARCHAR(120) NOT NULL,
        phone NVARCHAR(160) NULL,
        nationality NVARCHAR(160) NULL,
        occupation NVARCHAR(160) NULL,
        profile_photo NVARCHAR(MAX) NULL,
        role VARCHAR(10) NOT NULL CONSTRAINT DF_users_role DEFAULT ('member'),
        registration_status VARCHAR(10) NOT NULL CONSTRAINT DF_users_registration_status DEFAULT ('APPROVED'),
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_users_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_users_updated_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_users_role CHECK (role IN ('member', 'admin')),
        CONSTRAINT CK_users_registration_status CHECK (registration_status IN ('PENDING', 'APPROVED', 'REJECTED'))
    );
END
GO

IF EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE name = N'UQ_users_email' AND parent_object_id = OBJECT_ID(N'dbo.users')
)
BEGIN
    ALTER TABLE dbo.users DROP CONSTRAINT UQ_users_email;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'email' AND is_nullable = 0
)
BEGIN
    ALTER TABLE dbo.users ALTER COLUMN email NVARCHAR(254) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'UX_users_email')
BEGIN
    CREATE UNIQUE INDEX UX_users_email ON dbo.users(email) WHERE email IS NOT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'UX_users_phone_only')
BEGIN
    CREATE UNIQUE INDEX UX_users_phone_only ON dbo.users(phone)
        WHERE email IS NULL AND phone IS NOT NULL;
END
GO

IF OBJECT_ID(N'dbo.sessions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.sessions (
        id CHAR(32) NOT NULL CONSTRAINT PK_sessions PRIMARY KEY,
        user_id CHAR(32) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME2(3) NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_sessions_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_sessions_token_hash UNIQUE (token_hash),
        CONSTRAINT FK_sessions_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_sessions_user_id ON dbo.sessions(user_id);
    CREATE INDEX IX_sessions_expires_at ON dbo.sessions(expires_at);
END
GO

IF OBJECT_ID(N'dbo.auth_tokens', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.auth_tokens (
        token_hash CHAR(64) NOT NULL CONSTRAINT PK_auth_tokens PRIMARY KEY,
        user_id CHAR(32) NOT NULL,
        purpose VARCHAR(20) NOT NULL,
        expires_at DATETIME2(3) NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_auth_tokens_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_auth_tokens_purpose CHECK (purpose IN ('password_reset', 'invitation')),
        CONSTRAINT FK_auth_tokens_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_auth_tokens_expires_at ON dbo.auth_tokens(expires_at);
END
GO

IF OBJECT_ID(N'dbo.scriptures', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.scriptures (
        id CHAR(32) NOT NULL CONSTRAINT PK_scriptures PRIMARY KEY,
        reference NVARCHAR(200) NOT NULL,
        body NVARCHAR(MAX) NOT NULL,
        note NVARCHAR(MAX) NULL,
        active BIT NOT NULL CONSTRAINT DF_scriptures_active DEFAULT (1),
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_scriptures_created_at DEFAULT (SYSUTCDATETIME())
    );
    CREATE INDEX IX_scriptures_active_created_at ON dbo.scriptures(active, created_at);
END
GO

IF OBJECT_ID(N'dbo.scripture_broadcast', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.scripture_broadcast (
        singleton TINYINT NOT NULL CONSTRAINT PK_scripture_broadcast PRIMARY KEY,
        scripture_id CHAR(32) NULL,
        version CHAR(32) NOT NULL,
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_scripture_broadcast_updated_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_scripture_broadcast_singleton CHECK (singleton = 1),
        CONSTRAINT FK_scripture_broadcast_scripture FOREIGN KEY (scripture_id) REFERENCES dbo.scriptures(id) ON DELETE SET NULL
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.scripture_broadcast WHERE singleton = 1)
BEGIN
    INSERT INTO dbo.scripture_broadcast(singleton, scripture_id, version)
    VALUES (1, NULL, REPLACE(CONVERT(CHAR(36), NEWID()), '-', ''));
END
GO

IF OBJECT_ID(N'dbo.deliveries', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.deliveries (
        id CHAR(32) NOT NULL CONSTRAINT PK_deliveries PRIMARY KEY,
        user_id CHAR(32) NOT NULL,
        scripture_id CHAR(32) NOT NULL,
        broadcast_version CHAR(32) NOT NULL,
        delivered_at DATETIME2(3) NOT NULL CONSTRAINT DF_deliveries_delivered_at DEFAULT (SYSUTCDATETIME()),
        read_at DATETIME2(3) NULL,
        saved BIT NOT NULL CONSTRAINT DF_deliveries_saved DEFAULT (0),
        CONSTRAINT UQ_deliveries_user_broadcast UNIQUE (user_id, broadcast_version),
        CONSTRAINT FK_deliveries_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
        CONSTRAINT FK_deliveries_scripture FOREIGN KEY (scripture_id) REFERENCES dbo.scriptures(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_deliveries_saved ON dbo.deliveries(user_id, saved, delivered_at);
    CREATE INDEX IX_deliveries_delivered_at ON dbo.deliveries(delivered_at);
END
GO

IF OBJECT_ID(N'dbo.feedback', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.feedback (
        id CHAR(32) NOT NULL CONSTRAINT PK_feedback PRIMARY KEY,
        delivery_id CHAR(32) NOT NULL,
        user_id CHAR(32) NOT NULL,
        message NVARCHAR(MAX) NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_feedback_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT FK_feedback_delivery FOREIGN KEY (delivery_id) REFERENCES dbo.deliveries(id) ON DELETE CASCADE,
        CONSTRAINT FK_feedback_user FOREIGN KEY (user_id) REFERENCES dbo.users(id)
    );
    CREATE INDEX IX_feedback_created_at ON dbo.feedback(created_at);
END
GO

IF OBJECT_ID(N'dbo.donation_bank_accounts', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.donation_bank_accounts (
        id CHAR(32) NOT NULL CONSTRAINT PK_donation_bank_accounts PRIMARY KEY,
        currency CHAR(3) NOT NULL,
        beneficiary_name NVARCHAR(200) NULL,
        bank_name NVARCHAR(200) NULL,
        account_number NVARCHAR(100) NULL,
        iban NVARCHAR(100) NULL,
        swift_bic NVARCHAR(50) NULL,
        routing_number NVARCHAR(100) NULL,
        bank_address NVARCHAR(MAX) NULL,
        payment_instructions NVARCHAR(MAX) NULL,
        is_active BIT NOT NULL CONSTRAINT DF_donation_bank_accounts_active DEFAULT (1),
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_donation_bank_accounts_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_donation_bank_accounts_updated_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_donation_bank_accounts_currency UNIQUE (currency)
    );
END
GO

IF OBJECT_ID(N'dbo.donations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.donations (
        id CHAR(32) NOT NULL CONSTRAINT PK_donations PRIMARY KEY,
        reference VARCHAR(100) NOT NULL,
        payment_method VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL CONSTRAINT DF_donations_status DEFAULT ('initialized'),
        amount_minor BIGINT NOT NULL,
        currency CHAR(3) NOT NULL,
        donor_email NVARCHAR(254) NOT NULL,
        donor_name NVARCHAR(200) NULL,
        bank_account_id CHAR(32) NULL,
        transfer_reference NVARCHAR(200) NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_donations_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_donations_updated_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_donations_reference UNIQUE (reference),
        CONSTRAINT CK_donations_payment_method CHECK (payment_method IN ('paystack', 'bank_transfer')),
        CONSTRAINT CK_donations_status CHECK (status IN ('initialized', 'success', 'failed', 'pending_review', 'rejected')),
        CONSTRAINT CK_donations_amount CHECK (amount_minor >= 0),
        CONSTRAINT FK_donations_bank_account FOREIGN KEY (bank_account_id) REFERENCES dbo.donation_bank_accounts(id) ON DELETE SET NULL
    );
    CREATE INDEX IX_donations_status_created_at ON dbo.donations(status, created_at);
    CREATE INDEX IX_donations_donor_email ON dbo.donations(donor_email);
END
GO

IF OBJECT_ID(N'dbo.push_subscriptions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.push_subscriptions (
        id CHAR(32) NOT NULL CONSTRAINT PK_push_subscriptions PRIMARY KEY,
        user_id CHAR(32) NOT NULL,
        endpoint NVARCHAR(2048) NOT NULL,
        endpoint_hash CHAR(64) NOT NULL,
        p256dh NVARCHAR(256) NOT NULL,
        auth NVARCHAR(256) NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_push_subscriptions_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_push_subscriptions_endpoint_hash UNIQUE (endpoint_hash),
        CONSTRAINT FK_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
    );
END
GO

-- ---------------------------------------------------------------------------
-- Scripture delivery by email or phone (rerunnable; safe on existing databases)
-- ---------------------------------------------------------------------------

-- Where each member chose to receive their scripture at sign-up.
IF COL_LENGTH(N'dbo.users', N'delivery_channel') IS NULL
BEGIN
    ALTER TABLE dbo.users ADD delivery_channel VARCHAR(10) NOT NULL
        CONSTRAINT DF_users_delivery_channel DEFAULT ('email')
        CONSTRAINT CK_users_delivery_channel CHECK (delivery_channel IN ('email', 'phone'));
END
GO

-- One row per scripture sent (or attempted) to a member by an admin.
IF OBJECT_ID(N'dbo.scripture_sends', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.scripture_sends (
        id CHAR(32) NOT NULL CONSTRAINT PK_scripture_sends PRIMARY KEY,
        user_id CHAR(32) NOT NULL,
        scripture_id CHAR(32) NULL,
        channel VARCHAR(10) NOT NULL,
        destination NVARCHAR(254) NOT NULL,
        status VARCHAR(10) NOT NULL,
        error NVARCHAR(500) NULL,
        sent_by CHAR(32) NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_scripture_sends_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_scripture_sends_channel CHECK (channel IN ('email', 'phone')),
        CONSTRAINT CK_scripture_sends_status CHECK (status IN ('sent', 'failed')),
        CONSTRAINT FK_scripture_sends_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
        CONSTRAINT FK_scripture_sends_scripture FOREIGN KEY (scripture_id) REFERENCES dbo.scriptures(id) ON DELETE SET NULL
    );
    CREATE INDEX IX_scripture_sends_user ON dbo.scripture_sends(user_id, status, created_at);
END
GO

-- After registering, promote the first trusted account using its email:
-- UPDATE dbo.users SET role = 'admin' WHERE email = N'you@example.com';
