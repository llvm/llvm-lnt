// Based off of jquery.flot.touch.js (which is MIT Licensed), but
// dumber and using jquery.flot.navigate.js

(function($) {
    
    function init(plot) {                        
        var isOneTouch = false;
        var isTwoTouch = false;
        var isPan = false;
        var lastTouchCenter = [0,0];
        var lastDoubleTouchCenter = [0,0];
        var lastTouchPosition = [0,0];
        var lastTwoTouchPosition = [[0,0],[0,0]];
        var lastTwoTouchDistance = Infinity;
        var lastTouchTime = null;
        
        function bindEvents(plot, eventHolder) {
            if (plot.getOptions().touch.enabled === false)
                return;
            
            var placeholder = plot.getPlaceholder();
            
            placeholder.bind('touchstart', function(e) {
                var touches = e.originalEvent.touches;
                var offset = plot.offset();
                
                if (touches.length === 1) {
                    // Prepare for either double tap zoom
                    // or pan.
                    isOneTouch = true;
                    
                    lastTouchPosition = [touches[0].pageX,
                                         touches[0].pageY];
                    lastDoubleTouchCenter = [touches[0].pageX - offset.left,
                                             touches[0].pageY - offset.top];
                } else if (touches.length === 2) {
                    // Prepare for pinch zoom.           
                    isTwoTouch = true;
                    lastTwoTouchPosition = [[touches[0].pageX,
                                             touches[0].pageY],
                                            [touches[1].pageX,
                                             touches[1].pageY]];
                    lastTouchCenter = [(touches[1].pageX + touches[0].pageX)/2 - offset.left,
                                       (touches[1].pageY + touches[0].pageY)/2 - offset.top];
                    
                    var xdelta = touches[1].pageX - touches[0].pageX;
                    var ydelta = touches[1].pageY - touches[0].pageY;
                    lastTwoTouchDistance = Math.sqrt(xdelta*xdelta + ydelta*ydelta);
                }
                return false;
            });
            
            placeholder.bind('touchmove', function(e) {
                var touches = e.originalEvent.touches;
                
                if (isOneTouch && touches.length === 1) {
                    // If we hit a touchmove with one touch,
                    // we are panning.
                    var newTouchPosition = [touches[0].pageX,
                                            touches[0].pageY];
                    plot.pan({
                        left: lastTouchPosition[0] - newTouchPosition[0],
                        top: lastTouchPosition[1] - newTouchPosition[1]
                    });
                    
                    lastTouchPosition = newTouchPosition;
                    isPan = true;
                } else if (isTwoTouch && touches.length === 2) {
                    // If we hit a touchmove with one touch,
                    // we are zooming.
                    
                    // We look at the delta from our last positions and zoom
                    // in by the percent difference from the total distance in between
                    // the previous distance in between the fingers total.                    
                    var xdelta = touches[1].pageX - touches[0].pageX;
                    var ydelta = touches[1].pageY - touches[0].pageY;
                    var newTwoTouchDistance = Math.sqrt(xdelta*xdelta + ydelta*ydelta);
                    var scale = 1.0 + (newTwoTouchDistance - lastTwoTouchDistance)/lastTwoTouchDistance;
                    
                    plot.zoom({ amount: scale, center: { left: lastTouchCenter[0], top: lastTouchCenter[1] }});
                    
                    lastTwoTouchDistance = newTwoTouchDistance;
                }
                return false;
            });
            
            placeholder.bind('touchend', function(e) {
                var touches = e.originalEvent.touches;
                
                // Do the pan and or double click if it was quick.
                if (isOneTouch && !isPan) {
                    console.log('At touch end. Trying to double click.');
                    var now = new Date().getTime();
                    var lasttime = lastTouchTime || now + 1; // now + 1 so the first time we are negative.
                    var delta = now - lasttime;
                    
                    console.log("Now: " + now.toString() + "; LastTime: " + lasttime.toString() + " Delta: " + delta.toString());
                    
                    if (delta < 500 && delta > 0) {
                        console.log('Double touch success.');
                        // We have a double touch.
                        plot.zoom({ center: { left: lastDoubleTouchCenter[0],
                                              top: lastDoubleTouchCenter[1] }});
                        lastTouchTime = null;
                    } else {
                        lastTouchTime = now;
                    }                    
                }
                
                isOneTouch = false;
                isTwoTouch = false;
                isPan = false;
                return false;
            });
        }
        
        function shutdown(plot, eventHolder) {
            if (plot.getOptions().touch.enabled === false)
                return;
            var placeholder = plot.getPlaceholder();
            placeholder.unbind('touchstart').unbind('touchmove').unbind('touchend');
        }
        
        plot.hooks.bindEvents.push(bindEvents);
        plot.hooks.shutdown.push(shutdown);
        $(document).bind('ready orientationchange', function(e) {
	    window.scrollTo(0, 1);
	    
	    setTimeout(function() {
		$.plot(placeholder, plot.getData(), plot.getOptions());
	    }, 50);
	});
    }
    
    var options = {
        touch: {enabled: true}
    };
    $.plot.plugins.push({
        init: init,
        options: options,
        name: 'touch',
        version: '1.0'
    });
})(jQuery);
