// -*- mode: javascript; -*-

v4_global_status = {};
(function(_module) {
    // Assign our input module to a var so that a closure is created
    // in our local context.
    var m = _module;
    
    /* Globals */
    var g = {};
    
    /* Initialization */
    $(document).ready(function() {
        // Create a global variable for table.
        g.table = $('#data-table')[0];
        
        // Make left king control an accordion.
        $('#left-king-control').accordion({
            collapsible: true,
            autoHeight: false,
            active: 1
        });
    });
    
    /* Helper Functions */
    
    /* Exported Functions */
    
})(v4_global_status);
