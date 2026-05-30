module cerida::cerida {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use cerida::manager::AdminCap;

    /// TODO: define your primary shared object
    public struct Registry has key {
        id: UID,
    }

    fun init(ctx: &mut TxContext) {
        sui::transfer::share_object(Registry { id: object::new(ctx) });
    }


    /// Placeholder for admin-gated mutations
    public entry fun admin_action(_cap: &AdminCap, _registry: &mut Registry) {
        // TODO: implement
    }

    /// Placeholder for user-facing entry points
    public entry fun user_action(_registry: &mut Registry, _ctx: &mut TxContext) {
        // TODO: implement
    }
}
