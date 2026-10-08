-- Run once on databases created before admin scripture assignments were added.
create policy d_admin_ins on deliveries for insert with check(is_admin());