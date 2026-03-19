---
mode: 'agent'
tools: ['codebase', 'terminal']
description: 'Generate safe, reversible database migrations for Python (Alembic), JavaScript (Prisma/Knex), and Java (Flyway/Liquibase)'
---

# Database Migration — Safe & Reversible Guide

## Step 0 — Read Before Migrating
- Read ALL existing migration files to understand current schema state
- Read model/entity files for ALL changes to be captured
- Check if any data needs to be preserved/transformed (not just schema change)
- Never generate a migration without first verifying what changed
- Always test migration on a copy of production data before applying

---

## Python — Alembic

### Step 1 — Verify Models Are Updated
```python
# Confirm your SQLAlchemy model changes are saved in models/
# Example: adding a column
class Developer(Base):
    __tablename__ = "developers"
    id = Column(UUID, primary_key=True)
    org_id = Column(UUID, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    merit_score = Column(Float, default=0.0, nullable=False)  # ← NEW
    availability = Column(Boolean, default=True, nullable=False)  # ← NEW
    updated_at = Column(DateTime, onupdate=datetime.utcnow)
```

### Step 2 — Generate Migration
```bash
# Autogenerate from model diff
alembic revision --autogenerate -m "add_merit_score_and_availability_to_developers"

# For manual migration (when autogenerate misses something):
alembic revision -m "add_merit_score_and_availability_to_developers"
```

### Step 3 — ALWAYS Review Generated File
```python
# alembic/versions/xxxx_add_merit_score_and_availability_to_developers.py
"""add merit_score and availability to developers

Revision ID: a1b2c3d4e5f6
Revises: previous_revision_id
Create Date: 2026-03-19
"""
from alembic import op
import sqlalchemy as sa

def upgrade() -> None:
    # Adding NOT NULL column to existing table — need default for existing rows
    op.add_column('developers',
        sa.Column('merit_score', sa.Float(), nullable=False, server_default='0.0')
    )
    op.add_column('developers',
        sa.Column('availability', sa.Boolean(), nullable=False, server_default='true')
    )
    # Add index if this column will be queried
    op.create_index('ix_developers_merit_score', 'developers', ['merit_score'])

def downgrade() -> None:
    # downgrade MUST fully reverse upgrade — always implement this
    op.drop_index('ix_developers_merit_score', 'developers')
    op.drop_column('developers', 'availability')
    op.drop_column('developers', 'merit_score')
```

### Step 4 — Common Migration Patterns

#### Adding a NOT NULL column safely
```python
def upgrade() -> None:
    # Step 1: Add as nullable
    op.add_column('items', sa.Column('status', sa.String(50), nullable=True))
    
    # Step 2: Backfill existing rows
    op.execute("UPDATE items SET status = 'active' WHERE status IS NULL")
    
    # Step 3: Now make it NOT NULL
    op.alter_column('items', 'status', nullable=False)

def downgrade() -> None:
    op.drop_column('items', 'status')
```

#### Renaming a column (safe)
```python
def upgrade() -> None:
    op.alter_column('items', 'old_name', new_column_name='new_name')

def downgrade() -> None:
    op.alter_column('items', 'new_name', new_column_name='old_name')
```

#### Adding a foreign key
```python
def upgrade() -> None:
    op.add_column('items', sa.Column('owner_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_items_owner', 'items', 'users', ['owner_id'], ['id'],
                          ondelete='SET NULL')
    op.create_index('ix_items_owner_id', 'items', ['owner_id'])

def downgrade() -> None:
    op.drop_index('ix_items_owner_id', 'items')
    op.drop_constraint('fk_items_owner', 'items', type_='foreignkey')
    op.drop_column('items', 'owner_id')
```

#### Creating a new table
```python
def upgrade() -> None:
    op.create_table('sprints',
        sa.Column('id', sa.UUID(), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('org_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('status', sa.String(50), nullable=False, server_default='planning'),
        sa.Column('start_date', sa.Date(), nullable=True),
        sa.Column('end_date', sa.Date(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_sprints_org_id', 'sprints', ['org_id'])
    op.create_index('ix_sprints_org_status', 'sprints', ['org_id', 'status'])  # composite

def downgrade() -> None:
    op.drop_table('sprints')  # drops indexes automatically
```

### Step 5 — Apply & Verify
```bash
# Check current state
alembic current

# Preview SQL without applying
alembic upgrade head --sql

# Apply
alembic upgrade head

# Verify
alembic current

# Test rollback works
alembic downgrade -1
alembic upgrade head  # re-apply
```

---

## JavaScript — Prisma

### Step 1 — Update schema.prisma
```prisma
model Developer {
  id           String   @id @default(uuid())
  orgId        String
  name         String   @db.VarChar(255)
  meritScore   Float    @default(0.0)          // NEW
  availability Boolean  @default(true)          // NEW
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([orgId])
  @@index([orgId, meritScore])                 // NEW — for sorting/filtering
}
```

### Step 2 — Generate & Review Migration
```bash
npx prisma migrate dev --name add_merit_score_and_availability_to_developers
# Reviews the generated SQL in prisma/migrations/
```

### Step 3 — Review Generated SQL
```sql
-- prisma/migrations/TIMESTAMP_add_merit_score.../migration.sql
-- Check this file manually before applying to production
ALTER TABLE "developers" ADD COLUMN "merit_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "developers" ADD COLUMN "availability" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "developers_org_id_merit_score_idx" ON "developers"("org_id", "merit_score");
```

### Step 4 — Production Deploy
```bash
# Production: use migrate deploy (not dev)
npx prisma migrate deploy

# Never use migrate dev in production — it can reset DB
```

### Custom Seeding After Migration
```javascript
// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Backfill existing rows after adding column
  await prisma.$executeRaw`
    UPDATE developers 
    SET merit_score = 50.0 
    WHERE merit_score = 0.0 AND created_at < NOW() - INTERVAL '7 days'
  `;
}
main().then(() => prisma.$disconnect());
```

---

## JavaScript — Knex (manual migrations)

```javascript
// migrations/TIMESTAMP_add_merit_score_to_developers.js
exports.up = async (knex) => {
  await knex.schema.alterTable('developers', (table) => {
    table.float('merit_score').notNullable().defaultTo(0.0);
    table.boolean('availability').notNullable().defaultTo(true);
    table.index(['org_id', 'merit_score'], 'idx_developers_org_merit');
  });
  
  // Backfill if needed
  await knex('developers').whereNull('merit_score').update({ merit_score: 0.0 });
};

exports.down = async (knex) => {
  // Always implement — must fully reverse up()
  await knex.schema.alterTable('developers', (table) => {
    table.dropIndex(['org_id', 'merit_score'], 'idx_developers_org_merit');
    table.dropColumn('merit_score');
    table.dropColumn('availability');
  });
};
```

```bash
npx knex migrate:latest    # apply
npx knex migrate:rollback  # test rollback
npx knex migrate:latest    # re-apply
```

---

## Java — Flyway

### Naming Convention (CRITICAL — wrong name = Flyway ignores it)
```
V{version}__{description}.sql
V1__create_initial_schema.sql
V2__add_merit_score_to_developers.sql   ← double underscore
V2_1__add_availability_index.sql        ← sub-version ok
```

### Migration File
```sql
-- src/main/resources/db/migration/V5__add_merit_score_and_availability.sql

-- Step 1: Add columns (nullable first for safety)
ALTER TABLE developers
    ADD COLUMN merit_score DOUBLE PRECISION,
    ADD COLUMN availability BOOLEAN;

-- Step 2: Backfill existing rows
UPDATE developers SET merit_score = 0.0 WHERE merit_score IS NULL;
UPDATE developers SET availability = TRUE WHERE availability IS NULL;

-- Step 3: Apply constraints
ALTER TABLE developers
    ALTER COLUMN merit_score SET NOT NULL,
    ALTER COLUMN merit_score SET DEFAULT 0.0,
    ALTER COLUMN availability SET NOT NULL,
    ALTER COLUMN availability SET DEFAULT TRUE;

-- Step 4: Add indexes
CREATE INDEX idx_developers_org_merit ON developers(org_id, merit_score DESC);
```

### Flyway Undo (Pro) or Manual Rollback Script
```sql
-- V5__undo_add_merit_score.sql (keep in separate folder for reference)
ALTER TABLE developers
    DROP COLUMN IF EXISTS merit_score,
    DROP COLUMN IF EXISTS availability;
DROP INDEX IF EXISTS idx_developers_org_merit;
```

```bash
# Apply
./mvnw flyway:migrate

# Check status
./mvnw flyway:info

# Validate checksums match
./mvnw flyway:validate
```

---

## Universal Migration Checklist

**Before generating:**
- [ ] Model/entity files saved with all changes
- [ ] Understand if this is additive (add column) or destructive (drop column)
- [ ] Identify if existing data needs backfilling

**Reviewing the generated file:**
- [ ] `downgrade()` / rollback fully reverses `upgrade()` / forward
- [ ] NOT NULL columns have a `server_default` or backfill step
- [ ] New FK columns have an index
- [ ] Composite indexes added for common query patterns (org_id + status, org_id + created_at)
- [ ] No `DROP COLUMN` without data backup plan

**Applying:**
- [ ] `alembic upgrade head --sql` / preview SQL before applying
- [ ] Test rollback: `alembic downgrade -1` then `alembic upgrade head`
- [ ] Verify with `alembic current` / `flyway:info` / `prisma migrate status`

**Dangerous operations (require extra care):**
- Dropping a column → backup data first
- Renaming a column → two-phase: add new, copy data, drop old
- Adding NOT NULL → always backfill first, then constrain
- Large table changes → run during low-traffic window with `LOCK TIMEOUT`

Execute for: {{USER_REQUEST}}
