#[test_only]
module cerida::cerida_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use cerida::manager::AdminCap;

    const ADMIN: address = @0xA;
    const USER: address = @0xB;

    fun setup(): Scenario {
        let mut scenario = ts::begin(ADMIN);
        {
            // Package init runs automatically in test_scenario via publish
            // You can also call init functions explicitly here if needed
        };
        scenario
    }

    #[test]
    fun test_admin_cap_exists() {
        let mut scenario = setup();

        ts::next_tx(&mut scenario, ADMIN);
        {
            assert!(ts::has_most_recent_for_sender<AdminCap>(&scenario), 0);
        };

        ts::end(scenario);
    }

    // TODO: add tests for each entry point
}
