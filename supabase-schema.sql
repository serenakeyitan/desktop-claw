-- All Day Poke Social Ranking Schema for Supabase
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Profiles table (extends Supabase auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique not null,
  display_name text,
  avatar_url text,
  invite_code text unique not null,
  subscription_tier text default 'pro',  -- 'pro', 'max_100', 'max_200'
  created_at timestamptz default now()
);

-- Migration: add subscription_tier if the table already exists
alter table public.profiles add column if not exists subscription_tier text default 'pro';

-- Migration: add social profile links
alter table public.profiles add column if not exists twitter_username text;
alter table public.profiles add column if not exists github_username text;

-- Enable RLS
alter table public.profiles enable row level security;

-- Policies: anyone can read profiles, users can update their own
create policy "Profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- 2. Friendships table (bidirectional)
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  friend_id uuid references public.profiles(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(user_id, friend_id)
);

alter table public.friendships enable row level security;

-- Users can see their own friendships
create policy "Users can view own friendships"
  on public.friendships for select
  using (auth.uid() = user_id or auth.uid() = friend_id);

-- Users can insert friendships where they are the user_id
create policy "Users can add friends"
  on public.friendships for insert
  with check (auth.uid() = user_id);

-- Users can delete their own friendships
create policy "Users can remove friends"
  on public.friendships for delete
  using (auth.uid() = user_id);

-- 3. Usage logs table
create table if not exists public.usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  project text not null,
  delta_percent real not null,
  active_time_ms integer default 0,
  logged_at timestamptz not null,
  date date not null
);

alter table public.usage_logs enable row level security;

-- Users can insert their own logs
create policy "Users can insert own logs"
  on public.usage_logs for insert
  with check (auth.uid() = user_id);

-- Anyone can read logs (for global ranking)
create policy "Logs are viewable by everyone"
  on public.usage_logs for select using (true);

-- Index for fast ranking queries
create index if not exists idx_usage_logs_user_date
  on public.usage_logs(user_id, date);

create index if not exists idx_usage_logs_date
  on public.usage_logs(date);

-- 4. User status table (online/vibing status)
create table if not exists public.user_status (
  user_id uuid references public.profiles(id) on delete cascade primary key,
  is_vibing boolean default false,
  current_project text,
  last_active_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.user_status enable row level security;

-- Anyone can read status
create policy "Status is viewable by everyone"
  on public.user_status for select using (true);

-- Users can upsert their own status
create policy "Users can update own status"
  on public.user_status for update using (auth.uid() = user_id);

create policy "Users can insert own status"
  on public.user_status for insert with check (auth.uid() = user_id);

-- 5. Pokes table (friend-to-friend pokes)
create table if not exists public.pokes (
  id bigint generated always as identity primary key,
  sender_id uuid references public.profiles(id) on delete cascade not null,
  recipient_id uuid references public.profiles(id) on delete cascade not null,
  created_at timestamptz default now(),
  read_at timestamptz  -- null = unread
);

alter table public.pokes enable row level security;

-- Sender can insert pokes
create policy "Users can send pokes"
  on public.pokes for insert
  with check (auth.uid() = sender_id);

-- Recipient can read their own pokes
create policy "Users can read own pokes"
  on public.pokes for select
  using (auth.uid() = recipient_id);

-- Recipient can mark their pokes as read
create policy "Users can update own pokes"
  on public.pokes for update
  using (auth.uid() = recipient_id);

-- Index for fast unread poke queries
create index if not exists idx_pokes_recipient_unread
  on public.pokes(recipient_id, read_at) where read_at is null;

-- 6. Helper function: generate unique invite code
create or replace function generate_invite_code()
returns text as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i integer;
begin
  for i in 1..8 loop
    code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;
  return code;
end;
$$ language plpgsql;

-- 6. Function to add friend by invite code (creates bidirectional friendship)
create or replace function add_friend_by_code(code text)
returns json as $$
declare
  friend_profile public.profiles;
  current_user_id uuid := auth.uid();
begin
  -- Find the friend by invite code
  select * into friend_profile
    from public.profiles
    where invite_code = upper(code);

  if friend_profile is null then
    return json_build_object('success', false, 'error', 'Invalid invite code');
  end if;

  if friend_profile.id = current_user_id then
    return json_build_object('success', false, 'error', 'Cannot add yourself');
  end if;

  -- Check if already friends
  if exists (
    select 1 from public.friendships
    where user_id = current_user_id and friend_id = friend_profile.id
  ) then
    return json_build_object('success', false, 'error', 'Already friends');
  end if;

  -- Insert bidirectional friendship
  insert into public.friendships (user_id, friend_id)
    values (current_user_id, friend_profile.id)
    on conflict do nothing;

  insert into public.friendships (user_id, friend_id)
    values (friend_profile.id, current_user_id)
    on conflict do nothing;

  return json_build_object(
    'success', true,
    'friend', json_build_object(
      'id', friend_profile.id,
      'username', friend_profile.username,
      'display_name', friend_profile.display_name
    )
  );
end;
$$ language plpgsql security definer;

-- 7. Function to get friend rankings for a period
-- client_today: the client's local date as YYYY-MM-DD (avoids UTC timezone mismatch)
create or replace function get_friend_ranking(period text default 'all', client_today date default null)
returns json as $$
declare
  cutoff date;
  ref_date date := coalesce(client_today, current_date);
  current_user_id uuid := auth.uid();
begin
  case period
    when 'today' then cutoff := ref_date;
    when '7d' then cutoff := ref_date - interval '7 days';
    when '30d' then cutoff := ref_date - interval '30 days';
    else cutoff := '1970-01-01'::date;
  end case;

  return (
    select json_agg(row_to_json(r))
    from (
      select
        p.id as user_id,
        p.username,
        p.display_name,
        p.subscription_tier,
        p.twitter_username,
        p.github_username,
        coalesce(sum(ul.delta_percent), 0) as total_usage,
        coalesce(sum(ul.active_time_ms), 0) as total_time_ms,
        count(ul.id) as log_count,
        us.is_vibing,
        us.current_project,
        us.last_active_at
      from public.profiles p
      left join public.usage_logs ul
        on ul.user_id = p.id and ul.date >= cutoff
      left join public.user_status us
        on us.user_id = p.id
      where p.id = current_user_id
         or p.id in (
           select friend_id from public.friendships where user_id = current_user_id
         )
      group by p.id, p.username, p.display_name, p.subscription_tier, p.twitter_username, p.github_username, us.is_vibing, us.current_project, us.last_active_at
      order by coalesce(sum(ul.delta_percent), 0) desc
    ) r
  );
end;
$$ language plpgsql security definer;

-- 8. Function to get global ranking
-- client_today: the client's local date as YYYY-MM-DD (avoids UTC timezone mismatch)
create or replace function get_global_ranking(period text default 'all', lim integer default 50, client_today date default null)
returns json as $$
declare
  cutoff date;
  ref_date date := coalesce(client_today, current_date);
begin
  case period
    when 'today' then cutoff := ref_date;
    when '7d' then cutoff := ref_date - interval '7 days';
    when '30d' then cutoff := ref_date - interval '30 days';
    else cutoff := '1970-01-01'::date;
  end case;

  return (
    select json_agg(row_to_json(r))
    from (
      select
        p.username,
        p.display_name,
        p.subscription_tier,
        p.twitter_username,
        p.github_username,
        coalesce(sum(ul.delta_percent), 0) as total_usage,
        coalesce(sum(ul.active_time_ms), 0) as total_time_ms,
        count(ul.id) as log_count,
        us.is_vibing,
        us.last_active_at
      from public.profiles p
      left join public.usage_logs ul
        on ul.user_id = p.id and ul.date >= cutoff
      left join public.user_status us
        on us.user_id = p.id
      group by p.id, p.username, p.display_name, p.subscription_tier, p.twitter_username, p.github_username, us.is_vibing, us.last_active_at
      order by coalesce(sum(ul.delta_percent), 0) desc
      limit lim
    ) r
  );
end;
$$ language plpgsql security definer;
