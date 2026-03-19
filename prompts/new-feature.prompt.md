---
mode: 'agent'
tools: ['codebase', 'githubRepo']
description: 'Build a complete feature end-to-end in Python, JavaScript, or Java with proper architecture'
---

# Full Feature Build — End-to-End Guide

## Step 0 — Understand Before Building
Read these files FIRST, do not skip:
- Entry point: `main.py` / `app.js` / `Application.java`
- Project structure: understand what folders exist and their purpose
- Existing features: read one complete existing feature (model → service → controller → test) to match style
- Dependencies: `requirements.txt` / `package.json` / `pom.xml` — use what's already installed
- Environment: `.env.example` or config files — understand available env vars
- Database: existing migration files to understand current schema

**Output a plan before writing any code:**
```
Files to CREATE: [list]
Files to MODIFY: [list]
DB changes needed: [yes/no — describe]
New dependencies needed: [list or none]
Estimated complexity: [low/medium/high]
```

---

## Phase 1 — Data Layer

### Python (SQLAlchemy + Alembic)
```python
# 1. Define model in models/feature.py
# 2. Generate migration:
#    alembic revision --autogenerate -m "add_feature_table"
# 3. Review migration — check upgrade() AND downgrade()
# 4. Apply: alembic upgrade head

# Model must include:
# - UUID primary key (never auto-increment int for APIs)
# - org_id with index (multi-tenant)
# - created_at, updated_at timestamps
# - Proper column constraints (nullable, length, unique)
```

### JavaScript (Prisma)
```javascript
// 1. Add model to schema.prisma
// 2. npx prisma migrate dev --name add_feature_table
// 3. npx prisma generate
// 4. Review generated SQL in migrations/ folder

// Model must include:
// - id String @id @default(uuid())
// - orgId String with @@index([orgId])
// - createdAt DateTime @default(now())
// - updatedAt DateTime @updatedAt
```

### Java (Spring + Flyway)
```sql
-- Create: src/main/resources/db/migration/V{n}__add_feature_table.sql
CREATE TABLE features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_features_org_id (org_id)
);
```

---

## Phase 2 — API Layer

Build in this strict order (each depends on previous):
1. **Schema/DTO** — define request/response shapes with validation
2. **Repository/CRUD** — data access layer only, no business logic
3. **Service** — business logic, calls repository
4. **Controller/Router** — HTTP layer only, calls service, no business logic
5. **Register** — wire router into app entry point

**Never mix layers:**
- Controllers never touch DB directly
- Services never build HTTP responses
- Repositories never apply business rules

---

## Phase 3 — Business Logic

### Python (services/)
```python
# services/feature_service.py
class FeatureService:
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def process(self, data: FeatureRequest, org_id: UUID) -> FeatureResponse:
        # 1. Validate business rules (not just input format)
        await self._check_limits(org_id)
        
        # 2. Core logic
        result = await crud.create(self.db, data, org_id)
        
        # 3. Side effects (notifications, events) — after DB success
        await self._notify(result)
        
        return FeatureResponse.from_orm(result)
    
    async def _check_limits(self, org_id: UUID):
        count = await crud.count_by_org(self.db, org_id)
        if count >= 100:
            raise HTTPException(429, "Org limit reached")
```

### JavaScript (services/)
```javascript
// services/feature.service.js
class FeatureService {
  async process(data, orgId) {
    await this._checkLimits(orgId);         // business rules first
    const result = await featureRepo.create(data, orgId);
    await this._notify(result);              // side effects after
    return result;
  }
  
  async _checkLimits(orgId) {
    const count = await featureRepo.countByOrg(orgId);
    if (count >= 100) throw { status: 429, message: 'Org limit reached' };
  }
}
```

### Java (service/)
```java
@Service
@Transactional
public class FeatureService {
    public FeatureResponse process(FeatureRequest req, UUID orgId) {
        checkLimits(orgId);                          // business rules
        Feature saved = repo.save(toEntity(req, orgId));
        eventPublisher.publishEvent(new FeatureCreated(saved)); // side effects
        return mapper.map(saved, FeatureResponse.class);
    }
    
    private void checkLimits(UUID orgId) {
        if (repo.countByOrgId(orgId) >= 100)
            throw new ResponseStatusException(TOO_MANY_REQUESTS, "Org limit reached");
    }
}
```

---

## Phase 4 — Background Tasks (if needed)

### Python (Celery / FastAPI BackgroundTasks)
```python
# For lightweight: FastAPI BackgroundTasks
@router.post("/")
async def create(data: Request, background: BackgroundTasks, ...):
    result = await service.create(data)
    background.add_task(send_notification, result.id)  # non-blocking
    return result

# For heavy work: Celery task in tasks/
@celery.task(bind=True, max_retries=3)
def process_heavy(self, feature_id: str):
    try:
        # do work
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)
```

### JavaScript (Bull queue)
```javascript
// queues/feature.queue.js
const queue = new Bull('feature-processing');
queue.process(async (job) => {
  const { featureId } = job.data;
  // do work
});

// In service:
await featureQueue.add({ featureId: result.id }, { attempts: 3, backoff: 60000 });
```

---

## Phase 5 — Tests (Write These, Don't Skip)

### Python (pytest)
```python
# tests/test_feature.py
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_create_feature_success(client: AsyncClient, auth_headers, db):
    response = await client.post("/api/v1/features", 
        json={"name": "Test Feature"},
        headers=auth_headers)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test Feature"
    assert "org_id" in data

@pytest.mark.asyncio
async def test_create_feature_unauthorized(client: AsyncClient):
    response = await client.post("/api/v1/features", json={"name": "Test"})
    assert response.status_code == 401

@pytest.mark.asyncio
async def test_create_feature_validation_error(client: AsyncClient, auth_headers):
    response = await client.post("/api/v1/features", json={"name": ""},
        headers=auth_headers)
    assert response.status_code == 422

@pytest.mark.asyncio
async def test_get_feature_wrong_org(client: AsyncClient, other_org_headers, db, feature):
    # Cross-org access must return 404, not the other org's data
    response = await client.get(f"/api/v1/features/{feature.id}",
        headers=other_org_headers)
    assert response.status_code == 404
```

### JavaScript (Jest + Supertest)
```javascript
describe('Feature API', () => {
  test('POST /features - success', async () => {
    const res = await request(app)
      .post('/api/v1/features')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'Test Feature' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Feature');
  });

  test('POST /features - no auth', async () => {
    const res = await request(app).post('/api/v1/features').send({ name: 'Test' });
    expect(res.status).toBe(401);
  });

  test('GET /features/:id - wrong org cannot access', async () => {
    const res = await request(app)
      .get(`/api/v1/features/${otherOrgFeatureId}`)
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(404);
  });
});
```

---

## Phase 6 — Documentation

For every public function write:
```python
# Python
async def create_item(db: AsyncSession, data: ItemCreateRequest, org_id: UUID) -> Item:
    """
    Create a new item scoped to the given org.
    
    Args:
        db: Async database session
        data: Validated request data
        org_id: Organization ID from JWT (never from request)
    
    Returns:
        Created Item instance
        
    Raises:
        HTTPException 500: On database error (with rollback)
    """
```

```javascript
// JavaScript (JSDoc)
/**
 * Create a new feature scoped to org.
 * @param {Object} data - Validated request body
 * @param {string} orgId - Organization ID from JWT token
 * @returns {Promise<Feature>} Created feature record
 * @throws {Object} {status: 500, message: string} on DB error
 */
```

Update README if:
- New env vars required
- New setup steps needed
- New API endpoints added

---

## Error Correction Checklist
- [ ] No business logic in controllers/routers
- [ ] No HTTP concepts (status codes, req/res) in services
- [ ] No raw DB calls in controllers
- [ ] DB transactions wrap multi-step writes
- [ ] Background tasks handle their own errors (don't fail the request)
- [ ] Tests cover cross-org isolation (critical for multi-tenant)
- [ ] All new env vars added to `.env.example`
- [ ] Migration has a valid `downgrade()` / rollback

Execute for: {{USER_REQUEST}}
