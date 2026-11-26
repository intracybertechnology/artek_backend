-- ============================================================
--  Artek Computers LLC – Database Schema
--  Run via: npm run migrate
-- ============================================================

-- Users (admin accounts only – customers are not stored here)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(150)  NOT NULL,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash TEXT          NOT NULL,
  role          VARCHAR(20)   NOT NULL CHECK (role IN ('super_admin', 'admin')),
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Product categories
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  slug        VARCHAR(150) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Product subcategories (belong to a category)
CREATE TABLE IF NOT EXISTS subcategories (
  id          SERIAL PRIMARY KEY,
  category_id INTEGER      NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  name        VARCHAR(150) NOT NULL,
  slug        VARCHAR(150) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Brands
CREATE TABLE IF NOT EXISTS brands (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  slug       VARCHAR(150) NOT NULL UNIQUE,
  logo_path  TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  slug           VARCHAR(255) NOT NULL UNIQUE,
  model_number   VARCHAR(150) NOT NULL UNIQUE,
  description    TEXT,
  category_id    INTEGER      REFERENCES categories    (id) ON DELETE SET NULL,
  subcategory_id INTEGER      REFERENCES subcategories (id) ON DELETE SET NULL,
  brand_id       INTEGER      REFERENCES brands        (id) ON DELETE SET NULL,
  availability   VARCHAR(20)  NOT NULL DEFAULT 'available'
                              CHECK (availability IN ('available', 'out_of_stock', 'on_request')),
  specifications JSONB,
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  deleted_at     TIMESTAMPTZ  NULL,
  created_by     INTEGER      REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Product images
CREATE TABLE IF NOT EXISTS product_images (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER     NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  file_name  VARCHAR(255) NOT NULL,
  image_path TEXT         NOT NULL,
  is_primary BOOLEAN      NOT NULL DEFAULT false,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Quote requests submitted by site visitors
CREATE TABLE IF NOT EXISTS quote_requests (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(150)  NOT NULL,
  email        VARCHAR(255)  NOT NULL,
  phone        VARCHAR(50),
  company      VARCHAR(255),
  message      TEXT,
  product_id   INTEGER       REFERENCES products (id) ON DELETE SET NULL,
  product_name VARCHAR(255),
  model_number VARCHAR(150),
  brand_name   VARCHAR(150),
  email_sent   BOOLEAN       NOT NULL DEFAULT false,
  status       VARCHAR(20)   NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'contacted', 'closed')),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
--  Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_categories_slug        ON categories    (slug);
CREATE INDEX IF NOT EXISTS idx_subcategories_slug     ON subcategories (slug);
CREATE INDEX IF NOT EXISTS idx_brands_slug            ON brands        (slug);

CREATE INDEX IF NOT EXISTS idx_products_slug          ON products (slug);
CREATE INDEX IF NOT EXISTS idx_products_model_number  ON products (model_number);
CREATE INDEX IF NOT EXISTS idx_products_category_id   ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products (subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_brand_id      ON products (brand_id);
CREATE INDEX IF NOT EXISTS idx_products_deleted_at    ON products (deleted_at);

-- ============================================================
--  Insights (blog) posts
-- ============================================================

-- Blog articles for the "Insights" section of the site.
-- body and faqs are validated JSON arrays of typed blocks
-- (see src/utils/postBlocks.js) – nothing is rendered on the server.
CREATE TABLE IF NOT EXISTS posts (
  id               SERIAL PRIMARY KEY,
  slug             VARCHAR(255)  NOT NULL UNIQUE,
  title            VARCHAR(255)  NOT NULL,
  dek              TEXT,
  category         VARCHAR(100)  NOT NULL,
  tags             TEXT[]        DEFAULT '{}',
  author_id        TEXT          DEFAULT 'artek-team',
  published_at     DATE,
  featured         BOOLEAN       DEFAULT false,
  cover_word       VARCHAR(50),
  body             JSONB         NOT NULL DEFAULT '[]',
  faqs             JSONB         DEFAULT '[]',
  related_services TEXT[]        DEFAULT '{}',
  seo              JSONB,
  status           VARCHAR(20)   NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'needs-review', 'published')),
  created_by       INTEGER       REFERENCES users (id) ON DELETE SET NULL,
  deleted_at       TIMESTAMPTZ   NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_slug          ON posts (slug);
CREATE INDEX IF NOT EXISTS idx_posts_category      ON posts (category);
CREATE INDEX IF NOT EXISTS idx_posts_status        ON posts (status);
CREATE INDEX IF NOT EXISTS idx_posts_published_at  ON posts (published_at);
CREATE INDEX IF NOT EXISTS idx_posts_deleted_at   ON posts (deleted_at);

-- ============================================================
--  Testimonials (client quotes shown in the site's testimonial section)
-- ============================================================

-- One row per published client quote. Rows are only ever soft-deleted
-- (deleted_at set); image_path holds the public web path
-- (/uploads/testimonials/<file>) served by express.static in app.js.
CREATE TABLE IF NOT EXISTS testimonials (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  role         VARCHAR(100),
  company      VARCHAR(150),
  quote        TEXT         NOT NULL,
  rating       SMALLINT     NULL CHECK (rating BETWEEN 1 AND 5),
  image_path   TEXT         NULL,
  is_published BOOLEAN      DEFAULT true,
  sort_order   INT          DEFAULT 0,
  created_by   INT          REFERENCES users (id),
  deleted_at   TIMESTAMP    NULL,
  created_at   TIMESTAMP    DEFAULT now(),
  updated_at   TIMESTAMP    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_testimonials_is_published ON testimonials (is_published);
CREATE INDEX IF NOT EXISTS idx_testimonials_sort_order   ON testimonials (sort_order);
CREATE INDEX IF NOT EXISTS idx_testimonials_deleted_at   ON testimonials (deleted_at);
