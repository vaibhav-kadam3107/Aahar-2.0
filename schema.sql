-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- profile table
CREATE TABLE IF NOT EXISTS profile (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  height_cm NUMERIC,
  weight_kg NUMERIC,
  age INTEGER,
  gender TEXT,
  daily_calorie_goal INTEGER,
  daily_protein_goal INTEGER,
  daily_carb_goal INTEGER,
  daily_fat_goal INTEGER,
  daily_fiber_goal INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- meals table
CREATE TABLE IF NOT EXISTS meals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  image_path TEXT,
  meal_type TEXT,
  meal_name TEXT,
  total_calories NUMERIC,
  total_protein NUMERIC,
  total_carbohydrates NUMERIC,
  total_fat NUMERIC,
  total_fiber NUMERIC,
  micronutrients JSONB DEFAULT '{}'::jsonb,
  confidence_score NUMERIC,
  idempotency_key TEXT UNIQUE,
  consumed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- meal_food_items table
CREATE TABLE IF NOT EXISTS meal_food_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_name TEXT NOT NULL,
  estimated_quantity TEXT,
  estimated_grams NUMERIC,
  calories NUMERIC,
  protein NUMERIC,
  carbohydrates NUMERIC,
  fat NUMERIC,
  fiber NUMERIC
);

-- coach_messages table
CREATE TABLE IF NOT EXISTS coach_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- weight_logs table
CREATE TABLE IF NOT EXISTS weight_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  weight_kg NUMERIC NOT NULL,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create Indexes
CREATE INDEX IF NOT EXISTS idx_meals_user_id ON meals(user_id);
CREATE INDEX IF NOT EXISTS idx_meals_consumed_at ON meals(consumed_at);

CREATE INDEX IF NOT EXISTS idx_meal_food_items_meal_id ON meal_food_items(meal_id);

CREATE INDEX IF NOT EXISTS idx_coach_messages_user_id ON coach_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_coach_messages_created_at ON coach_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_weight_logs_user_id ON weight_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_weight_logs_logged_at ON weight_logs(logged_at);

-- Enable RLS
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_food_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_logs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any to prevent duplicate policy errors
DROP POLICY IF EXISTS profile_policy ON profile;
DROP POLICY IF EXISTS meals_policy ON meals;
DROP POLICY IF EXISTS meal_food_items_policy ON meal_food_items;
DROP POLICY IF EXISTS coach_messages_policy ON coach_messages;
DROP POLICY IF EXISTS weight_logs_policy ON weight_logs;

-- Create Policies (FOR ALL operations to owning users)
CREATE POLICY profile_policy ON profile
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY meals_policy ON meals
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY meal_food_items_policy ON meal_food_items
  FOR ALL
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM meals 
    WHERE meals.id = meal_food_items.meal_id 
    AND meals.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM meals 
    WHERE meals.id = meal_food_items.meal_id 
    AND meals.user_id = auth.uid()
  ));

CREATE POLICY coach_messages_policy ON coach_messages
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY weight_logs_policy ON weight_logs
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
