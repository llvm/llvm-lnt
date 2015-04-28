/** Provide date conversions to the utctime and reltime classes.


Use JQuery to update the iso times rendered in the templates to browswer local
time.
*/

jQuery(function() {
    jQuery(".utctime").each(function (idx, elem) {
        jQuery(elem).text(jQuery.format.toBrowserTimeZone(jQuery(elem).text()));
    });

    jQuery(".reltime").each(function (idx, elem) {
        var time_text = jQuery(elem).text();
        jQuery(elem).tooltip({'title': jQuery.format.toBrowserTimeZone(time_text),
                            'delay': { show: 500, hide: 1000 }
                                });
    });

    jQuery(".reltime").each(function (idx, elem) {
        jQuery(elem).text(jQuery.format.prettyDate(jQuery(elem).text()));

    });

});
